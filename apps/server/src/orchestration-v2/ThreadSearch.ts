import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  OrchestrationV2AppThreadJson,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  messageSearchTokens,
  foldSearchQuery,
  rankMessageMatches,
  rankSearchItems,
  scoreMessageMatch,
  scoreThreadSearch,
  spellOutLetters,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";
import { threadSearchPullRequests } from "@t3tools/shared/threadPullRequests";
import { indexedMessageCondition } from "./messageSearchIndex.ts";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

// Token lists bind as JSON arrays, so any number of them is one parameter.
const TokenList = Schema.fromJsonString(Schema.Array(Schema.String));
const SearchRequest = Schema.Struct({
  /** The FTS5 query, or null to scan messages instead. */
  match: Schema.NullOr(Schema.String),
  /** Tokens every hit must contain, checked on the text. */
  substrings: TokenList,
  projectId: Schema.NullOr(ProjectId),
  /** Threads a first read already found, so a second read reaches others. */
  excludedThreadIds: TokenList,
});
const SearchRow = Schema.Struct({
  messageRowid: Schema.Number,
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  text: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

const SNIPPET_LENGTH = 240;
// The newest hits read per query. A common word stops here instead of reading
// every message, so time stays flat as history grows.
const MESSAGE_HIT_LIMIT = 2000;
// Without the index, how many of the newest messages a search scans.
const MESSAGE_SCAN_LIMIT = 20_000;

// What can come right before a word, for the index pass that finds words a
// common fragment's newest hits missed. Indexed text starts with a space, so
// a message's first word counts. camelCase joins ("enableIngest") are left to
// the newest hits: the index ignores case.
const WORD_BOUNDARIES = [
  " ",
  "\n",
  "\t",
  "(",
  "[",
  "{",
  "`",
  '"',
  "'",
  "/",
  "-",
  "_",
  ".",
  ":",
  "#",
  "@",
  "*",
  ">",
];

/**
 * The SQL inputs for a message search, or null when the query has no token
 * long enough to search. Tokens of three or more characters go to the
 * trigram index as quoted phrases; shorter ones, and every token when the
 * index cannot serve the query, are checked as substrings of the hits.
 */
function buildMessageSearch(
  query: string,
  hasIndex: boolean,
):
  | (Omit<typeof SearchRequest.Type, "projectId" | "excludedThreadIds"> & {
      /** The same tokens after a space, for words a common fragment's newest hits miss. */
      readonly wordMatch: string | null;
    })
  | null {
  const { long, short } = messageSearchTokens(query);
  if (long.length === 0) return null;
  // Two-character CJK words are too short for trigrams.
  const indexed = hasIndex && long.every((token) => Array.from(token).length >= 3);
  const phrase = (text: string) => `"${spellOutLetters(text).replaceAll('"', '""')}"`;
  return {
    match: indexed ? long.map(phrase).join(" ") : null,
    wordMatch: indexed
      ? long
          .map(
            (token) => `(${WORD_BOUNDARIES.map((before) => phrase(before + token)).join(" OR ")})`,
          )
          .join(" AND ")
      : null,
    substrings: indexed ? short : [...long, ...short],
  };
}

// Result rows show one line, so the match must sit near the start to be seen.
const SNIPPET_LEAD = 24;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Up to 240 characters starting a few words before the match at `matchStart`,
 * with ellipses where the text was cut. Only the shown part has its
 * whitespace collapsed, so an offset into the raw text stays valid.
 */
export function buildSearchSnippet(text: string, matchStart: number): string {
  if (matchStart <= SNIPPET_LEAD * 2 && text.length <= SNIPPET_LENGTH * 2) {
    const whole = text.replace(/\s+/g, " ").trim();
    if (whole.length <= SNIPPET_LENGTH) return whole;
  }
  let start = Math.max(0, matchStart - SNIPPET_LEAD);
  const wordStart = text.slice(start, matchStart).search(/\s/);
  if (start > 0 && wordStart !== -1) start += wordStart + 1;
  // Cut between characters, not inside an emoji's surrogate pair.
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  // Collapsing whitespace shortens the text, so read a little more of it.
  const rawEnd = Math.min(text.length, start + SNIPPET_LENGTH * 2);
  const shown = text.slice(start, rawEnd).replace(/\s+/g, " ").trim();
  const bodyLength = SNIPPET_LENGTH - 2;
  let end = Math.min(shown.length, bodyLength);
  if (isLowSurrogate(shown.charCodeAt(end))) end--;
  const cut = end < shown.length || rawEnd < text.length;
  return `${start > 0 ? "…" : ""}${shown.slice(0, end)}${cut ? "…" : ""}`;
}

// The newest messages that hold every token, from active, non-subagent
// threads. Every palette and sidebar hides subagent threads, so their
// messages would only use up the hit limit; filters apply before it, so
// hidden threads never crowd out a visible match. Word starts and ranking
// happen in JS, with the rules titles use.
//
// Without the index (an SQLite build without FTS5 trigrams, see migration
// 69) or for two-character CJK words, the same query scans the newest
// messages migration 69 would index. That scan is weaker than the index: it
// ignores case for ASCII only and does not fold accents ("cafe" misses
// "café"). Exported so a test can check the query plan.
export const messageHitsQuery = (
  sql: SqlClient.SqlClient,
  { match, substrings, projectId, excludedThreadIds }: typeof SearchRequest.Encoded,
) => sql`
    WITH eligible AS MATERIALIZED (
      SELECT threads.thread_id, threads.project_id
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND (${projectId} IS NULL OR threads.project_id = ${projectId})
        AND threads.thread_id NOT IN (SELECT value FROM json_each(${excludedThreadIds}))
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent')
          IS NOT 'subagent'
    )
    ${
      match === null
        ? sql`
          SELECT
            messages.rowid AS "messageRowid",
            messages.thread_id AS "threadId",
            eligible.project_id AS "projectId",
            messages.role AS source,
            json_extract(messages.payload_json, '$.text') AS text,
            messages.created_at AS "messageCreatedAt"
          FROM orchestration_v2_projection_messages AS messages
          INNER JOIN eligible ON eligible.thread_id = messages.thread_id
          WHERE ${indexedMessageCondition(sql)}
            -- A scan reads every message it passes, so it stops at the newest ones.
            AND messages.rowid > (
              SELECT coalesce(max(rowid), 0) FROM orchestration_v2_projection_messages
            ) - ${MESSAGE_SCAN_LIMIT}
        `
        : sql`
          SELECT
            orchestration_v2_message_search.rowid AS "messageRowid",
            messages.thread_id AS "threadId",
            eligible.project_id AS "projectId",
            messages.role AS source,
            json_extract(messages.payload_json, '$.text') AS text,
            messages.created_at AS "messageCreatedAt"
          FROM orchestration_v2_message_search
          INNER JOIN orchestration_v2_projection_messages AS messages
            ON messages.rowid = orchestration_v2_message_search.rowid
          INNER JOIN eligible ON eligible.thread_id = messages.thread_id
          WHERE orchestration_v2_message_search MATCH ${match}
        `
    }
      AND NOT EXISTS (
        SELECT 1 FROM json_each(${substrings}) AS token
        WHERE instr(lower(json_extract(messages.payload_json, '$.text')), token.value) = 0
      )
    -- The index's own rowid, so FTS5 returns hits newest first and stops at
    -- the limit; ordering by the messages table's rowid sorts every hit.
    ORDER BY "messageRowid" DESC
    LIMIT ${MESSAGE_HIT_LIMIT}
  `;

const TitleCandidateRow = Schema.Struct({
  thread: Schema.fromJsonString(OrchestrationV2AppThreadJson),
  projectTitle: Schema.String,
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
});

export interface ThreadSearchHit {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly source: "title" | OrchestrationThreadSearchSource;
  readonly snippet?: string;
  readonly messageCreatedAt?: string | null;
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    /** Message text matches, for clients that rank their own thread list. */
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
    /**
     * Title, branch, pull request, and project matches ranked as the command
     * palette ranks them, then message matches for the remaining threads.
     */
    readonly searchThreads: (
      input: OrchestrationSearchThreadsInput & { readonly projectId?: ProjectId | undefined },
    ) => Effect.Effect<{ readonly matches: ReadonlyArray<ThreadSearchHit> }, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: (request) => messageHitsQuery(sql, request),
  });

  const titleCandidates = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.NullOr(ProjectId) }),
    Result: TitleCandidateRow,
    execute: ({ projectId }) => sql`
      SELECT
        threads.payload_json AS thread,
        projects.title AS "projectTitle",
        (
          SELECT messages.updated_at
          FROM orchestration_v2_projection_messages AS messages
          WHERE messages.thread_id = threads.thread_id
            AND messages.role = 'user'
            AND COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user'
          ORDER BY messages.updated_at DESC, messages.message_id DESC
          LIMIT 1
        ) AS "latestUserMessageAt"
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent')
          IS NOT 'subagent'
        AND (${projectId} IS NULL OR threads.project_id = ${projectId})
    `,
  });

  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new ThreadSearchError({
            operation: Schema.isSchemaError(cause) ? "decode" : "query",
            cause,
          }),
      ),
    );

  // A project scope applies before ranking, so other projects' stronger hits
  // cannot use up the limit.
  const searchMessages = Effect.fn("ThreadSearch.searchMessages")(function* (
    input: OrchestrationSearchThreadsInput & { readonly projectId: ProjectId | null },
  ) {
    // One message per thread: the best word match, then what the user wrote,
    // since that is what they remember asking, then the newest by when it was
    // written. Threads order by that match, then its age. Row order is not
    // age: imported histories arrive in one batch. Text relevance (bm25)
    // would cost a pass over every hit in history.
    type Hit = {
      readonly row: typeof SearchRow.Type;
      readonly quality: number;
      readonly midWord: boolean;
      readonly offset: number;
    };
    const newer = (left: Hit, right: Hit) =>
      (right.row.messageCreatedAt ?? "").localeCompare(left.row.messageCreatedAt ?? "");
    const compareHits = (left: Hit, right: Hit) =>
      right.quality - left.quality ||
      Number(left.row.source !== "user") - Number(right.row.source !== "user") ||
      newer(left, right);
    const best = new Map<ThreadId, Hit>();
    // Returns how many rows matched as words.
    const addRows = (rows: ReadonlyArray<typeof SearchRow.Type>) => {
      let words = 0;
      for (const row of rows) {
        const match = scoreMessageMatch(row.text, input.query);
        if (match === null) continue;
        if (!match.midWord) words++;
        const hit = { row, ...match };
        const current = best.get(row.threadId);
        if (current === undefined || compareHits(hit, current) < 0) best.set(row.threadId, hit);
      }
      return words;
    };
    yield* read(
      Effect.gen(function* () {
        const index = yield* sql`
          SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
        `;
        const messageSearch = buildMessageSearch(input.query, index.length > 0);
        if (messageSearch === null) return;
        const { match, wordMatch, substrings } = messageSearch;
        const projectId = input.projectId;
        const newest = yield* searchRows({ match, substrings, projectId, excludedThreadIds: [] });
        const words = addRows(newest);
        if (newest.length < MESSAGE_HIT_LIMIT) return;
        // A full page can hold few words ("ing" sits mostly inside words) or few
        // threads (one busy thread's newest messages). Read once more past the
        // threads that already have a word match: words after a boundary when
        // the hits sat mostly inside words, else the same query.
        const mostlyInsideWords = words * 2 < newest.length;
        if (!mostlyInsideWords && best.size >= (input.limit ?? 50)) return;
        const found = [...best].flatMap(([threadId, hit]) => (hit.midWord ? [] : [threadId]));
        const older = yield* searchRows({
          match: mostlyInsideWords && wordMatch !== null ? wordMatch : match,
          substrings,
          projectId,
          excludedThreadIds: found,
        });
        addRows(older);
      }),
    );
    const ranked = [...best.values()].sort(
      (left, right) => right.quality - left.quality || newer(left, right),
    );
    return {
      matches: ranked.slice(0, input.limit ?? 50).map(({ row, quality, offset }) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.text, offset),
        messageCreatedAt: row.messageCreatedAt,
        quality,
      })),
    };
  });

  const search: ThreadSearch["Service"]["search"] = (input) =>
    searchMessages({ ...input, projectId: null });

  const searchThreads: ThreadSearch["Service"]["searchThreads"] = Effect.fn(
    "ThreadSearch.searchThreads",
  )(function* (input) {
    const limit = input.limit ?? 50;
    const normalizedQuery = foldSearchQuery(input.query);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    // Agents call this rarely, and a project has hundreds of threads, not
    // millions, so ranking every active thread in memory stays cheap.
    const candidates = yield* read(titleCandidates({ projectId: input.projectId ?? null }));
    const subjectById = new Map(
      candidates.map((row): [ThreadId, ThreadSearchSubject] => [
        row.thread.id,
        {
          id: row.thread.id,
          title: row.thread.title,
          branch: row.thread.branch,
          projectTitle: row.projectTitle,
          pullRequests: threadSearchPullRequests(row.thread),
          // Like the clients: what the user last wrote, else when the thread began.
          activityAt: Date.parse(
            row.latestUserMessageAt ?? DateTime.formatIso(row.thread.createdAt),
          ),
          opens: row.thread.opens ?? null,
        },
      ]),
    );
    const titleHits: ThreadSearchHit[] = rankSearchItems(candidates, (row, options) =>
      // An agent's search has no use for the user's palette picks.
      scoreThreadSearch(normalizedQuery, subjectById.get(row.thread.id)!, now, {
        ...options,
        picks: false,
      }),
    )
      .slice(0, limit)
      .map(({ item }) => ({
        threadId: item.thread.id,
        projectId: item.thread.projectId,
        title: item.thread.title,
        source: "title",
      }));
    if (titleHits.length >= limit) return { matches: titleHits };
    const shown = new Set(titleHits.map((hit) => hit.threadId));
    const { matches } = yield* searchMessages({
      query: input.query,
      limit: 50,
      projectId: input.projectId ?? null,
    });
    const messageHits = rankMessageMatches(
      matches.filter((match) => subjectById.has(match.threadId) && !shown.has(match.threadId)),
      (match) => subjectById.get(match.threadId),
      normalizedQuery,
      now,
      { picks: false },
    ).map(({ quality: _quality, ...match }) => ({
      ...match,
      title: subjectById.get(match.threadId)!.title,
    }));
    return { matches: [...titleHits, ...messageHits].slice(0, limit) };
  });

  return ThreadSearch.of({ search, searchThreads });
});

export const layer = Layer.effect(ThreadSearch, make);
