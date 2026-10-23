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
});
const SearchRow = Schema.Struct({
  messageRowid: Schema.Number,
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  text: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  score: Schema.Number,
});

const SNIPPET_LENGTH = 240;
// The newest hits read per query. A common word stops here instead of reading
// every message, so time stays flat as history grows.
const MESSAGE_HIT_LIMIT = 2000;
// Without the index, how many of the newest messages a search scans.
const MESSAGE_SCAN_LIMIT = 20_000;

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
  | (Omit<typeof SearchRequest.Type, "projectId"> & {
      /** The same tokens after a space, for words a common fragment's newest hits miss. */
      readonly wordMatch: string | null;
    })
  | null {
  const { long, short } = messageSearchTokens(query);
  if (long.length === 0) return null;
  // Two-character CJK words are too short for trigrams.
  const indexed = hasIndex && long.every((token) => Array.from(token).length >= 3);
  const phrases = (prefix: string) =>
    long.map((token) => `"${prefix}${token.replaceAll('"', '""')}"`).join(" ");
  return {
    match: indexed ? phrases("") : null,
    wordMatch: indexed ? phrases(" ") : null,
    substrings: indexed ? short : [...long, ...short],
  };
}

// Result rows show one line, so the match must sit near the start to be seen.
const SNIPPET_LEAD = 24;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Up to 240 characters starting a few words before the first match, with
 * ellipses where the text was cut.
 */
export function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const matchStart = scoreMessageMatch(normalizedText, query)?.offset ?? 0;
  if (normalizedText.length <= SNIPPET_LENGTH && matchStart <= SNIPPET_LEAD * 2) {
    return normalizedText;
  }
  const bodyLength = SNIPPET_LENGTH - 2;
  let start = Math.max(0, matchStart - SNIPPET_LEAD);
  const wordStart = normalizedText.indexOf(" ", start);
  if (start > 0 && wordStart !== -1 && wordStart < matchStart) start = wordStart + 1;
  let end = Math.min(normalizedText.length, start + bodyLength);
  // Cut between characters, not inside an emoji's surrogate pair.
  if (isLowSurrogate(normalizedText.charCodeAt(start))) start++;
  if (isLowSurrogate(normalizedText.charCodeAt(end))) end--;
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

// The newest messages that hold every token, from active, non-subagent
// threads. Every palette and sidebar hides subagent threads, so their
// messages would only use up the hit limit; filters apply before it, so
// hidden threads never crowd out a visible match. Word starts and ranking
// happen in JS, with the rules titles use.
//
// Without the index (an SQLite build without FTS5 trigrams, see migration
// 69) or for two-character CJK words, the same query scans the messages
// migration 69 would index. Exported so a test can check the query plan.
export const messageHitsQuery = (
  sql: SqlClient.SqlClient,
  { match, substrings, projectId }: typeof SearchRequest.Encoded,
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
            messages.created_at AS "messageCreatedAt",
            0 AS score
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
            messages.created_at AS "messageCreatedAt",
            bm25(orchestration_v2_message_search) AS score
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
          WHERE messages.thread_id = threads.thread_id AND messages.role = 'user'
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
    // One message per thread: one where every word starts a word, then what the
    // user wrote, since that is what they remember asking, then the best text
    // match. Rows arrive newest first, so ties keep the newest.
    type Hit = {
      readonly row: typeof SearchRow.Type;
      readonly quality: number;
      readonly midWord: boolean;
    };
    const compareHits = (left: Hit, right: Hit) =>
      right.quality - left.quality ||
      Number(left.row.source !== "user") - Number(right.row.source !== "user") ||
      left.row.score - right.row.score;
    const best = new Map<ThreadId, Hit>();
    // Returns how many rows matched as words.
    const addRows = (rows: ReadonlyArray<typeof SearchRow.Type>) => {
      let words = 0;
      for (const row of rows) {
        const match = scoreMessageMatch(row.text, input.query);
        if (match === null) continue;
        if (!match.midWord) words++;
        const hit = { row, quality: match.quality, midWord: match.midWord };
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
        const newest = yield* searchRows({ match, substrings, projectId: input.projectId });
        const words = addRows(newest);
        // When most of the newest hits sit inside words ("ing"), older words
        // after a space come from the index instead.
        if (newest.length < MESSAGE_HIT_LIMIT || wordMatch === null || words * 2 >= newest.length) {
          return;
        }
        const seen = new Set(newest.map((row) => row.messageRowid));
        const older = yield* searchRows({
          match: wordMatch,
          substrings,
          projectId: input.projectId,
        });
        addRows(older.filter((row) => !seen.has(row.messageRowid)));
      }),
    );
    const ranked = [...best.values()].sort(
      (left, right) => right.quality - left.quality || left.row.score - right.row.score,
    );
    return {
      matches: ranked.slice(0, input.limit ?? 50).map(({ row, midWord }) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.text, input.query),
        messageCreatedAt: row.messageCreatedAt,
        ...(midWord ? { midWord: true as const } : {}),
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
          // Like the clients: the latest user message, else the last update.
          activityAt: Date.parse(
            row.latestUserMessageAt ?? DateTime.formatIso(row.thread.updatedAt),
          ),
          opens: row.thread.opens ?? null,
        },
      ]),
    );
    const titleHits: ThreadSearchHit[] = rankSearchItems(candidates, (row, options) =>
      scoreThreadSearch(normalizedQuery, subjectById.get(row.thread.id)!, now, options),
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
      matches.flatMap((match, rank) =>
        subjectById.has(match.threadId) && !shown.has(match.threadId) ? [{ ...match, rank }] : [],
      ),
      (match) => subjectById.get(match.threadId),
      normalizedQuery,
      now,
    ).map(({ rank: _rank, midWord: _midWord, ...match }) => ({
      ...match,
      title: subjectById.get(match.threadId)!.title,
    }));
    return { matches: [...titleHits, ...messageHits].slice(0, limit) };
  });

  return ThreadSearch.of({ search, searchThreads });
});

export const layer = Layer.effect(ThreadSearch, make);
