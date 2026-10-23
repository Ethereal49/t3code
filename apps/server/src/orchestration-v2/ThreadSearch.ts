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
  firstSearchTokenOffset,
  messageSearchTokens,
  messageTokenNeedsWordStart,
  foldSearchQuery,
  rankMessageMatches,
  rankSearchItems,
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

const WordStart = Schema.Struct({
  /** The plain token, checked against the lowercased text. */
  word: Schema.String,
  /** The token as a capital after a lowercase letter ("enableFTS"). */
  camel: Schema.String,
  /** Accent-insensitive patterns, for hits the index matched through accents. */
  accented: Schema.Array(Schema.String),
});

// Token lists bind as JSON arrays, so any number of them is one parameter.
const TokenList = Schema.fromJsonString(Schema.Array(Schema.String));
const SearchRequest = Schema.Struct({
  /** The FTS5 query, or null to scan messages instead. */
  match: Schema.NullOr(Schema.String),
  /** Tokens every hit must contain, checked on the text. */
  substrings: TokenList,
  /** Short tokens that must start a word in the hit. */
  wordStarts: Schema.fromJsonString(Schema.Array(WordStart)),
  projectId: Schema.NullOr(ProjectId),
  limit: Schema.Int,
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

const SNIPPET_LENGTH = 240;
const MESSAGE_HIT_LIMIT = 5000;

// Latin letters with their accented forms. SQLite's GLOB is case-sensitive
// and knows no accents, so each letter becomes a class of every form.
const LETTER_FORMS: Readonly<Record<string, string>> = {
  a: "aàáâãäåāăą",
  c: "cçćĉċč",
  e: "eèéêëēĕėęě",
  i: "iìíîïĩīĭįı",
  n: "nñńņň",
  o: "oòóôõöøōŏő",
  s: "sśŝşš",
  u: "uùúûüũūŭůűų",
  y: "yýÿŷ",
  z: "zźżž",
};
const WORD_CHARACTERS = `a-zA-Z0-9${Object.values(LETTER_FORMS).join("")}${Object.values(
  LETTER_FORMS,
)
  .join("")
  .toUpperCase()}`;

function letterClass(letter: string): string {
  const forms = LETTER_FORMS[letter] ?? letter;
  return `[${forms}${forms.toUpperCase()}]`;
}

/**
 * How the server checks that a short ASCII `token` starts a word in a hit.
 * Most hits contain the token as typed, so cheap lowercase patterns come first;
 * the accent-aware ones, slow on long text, only run when it does not appear
 * as typed ("res" in "Résumé").
 */
function wordStart(token: string): typeof WordStart.Type {
  const caseless = (letter: string) => `[${letter}${letter.toUpperCase()}]`;
  const accentedWord = `${Array.from(token, letterClass).join("")}*`;
  return {
    word: token,
    camel: `*[a-z]${token[0]!.toUpperCase()}${Array.from(token.slice(1), caseless).join("")}*`,
    accented: [accentedWord, `*[^${WORD_CHARACTERS}]${accentedWord}`],
  };
}

/**
 * The SQL inputs for a message search, or null when the query has no token
 * long enough to search. Tokens of three or more characters go to the
 * trigram index as quoted phrases; shorter ones, and every token when the
 * index cannot serve the query, are checked as substrings of the hits.
 */
function buildMessageSearch(
  query: string,
  hasIndex: boolean,
): Omit<typeof SearchRequest.Type, "projectId" | "limit"> | null {
  const { long, short } = messageSearchTokens(query);
  if (long.length === 0) return null;
  // Two-character CJK words are too short for trigrams.
  const indexed = hasIndex && long.every((token) => Array.from(token).length >= 3);
  return {
    match: indexed ? long.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ") : null,
    substrings: indexed ? short : [...long, ...short],
    wordStarts: [...long, ...short].filter(messageTokenNeedsWordStart).map(wordStart),
  };
}

// Result rows show one line, so the match must sit near the start to be seen.
const SNIPPET_LEAD = 24;

/**
 * Up to 240 characters starting a few words before the first match, with
 * ellipses where the text was cut. Messages can be long, so this finds the
 * match with a plain lowercase search rather than folding the whole text.
 */
export function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const matchStart = firstSearchTokenOffset(normalizedText, query);
  if (normalizedText.length <= SNIPPET_LENGTH && matchStart <= SNIPPET_LEAD * 2) {
    return normalizedText;
  }
  const bodyLength = SNIPPET_LENGTH - 2;
  let start = Math.max(0, matchStart - SNIPPET_LEAD);
  const wordStart = normalizedText.indexOf(" ", start);
  if (start > 0 && wordStart !== -1 && wordStart < matchStart) start = wordStart + 1;
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

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

  // One message per active, non-subagent thread: a user message when one
  // matches, since that is what the user remembers asking. Threads order by
  // their best bm25 hit, or by recency when scanning. Every palette and sidebar
  // hides subagent threads, so their messages would only use up the limit.
  // Filters apply before ranking, so hidden threads never crowd out a visible
  // match, and message bodies are read only for the winners.
  //
  // Without the index (an SQLite build without FTS5 trigrams, see migration
  // 69) or for two-character CJK words, the same query scans the messages
  // migration 69 would index.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ match, substrings, wordStarts, projectId, limit }) => sql`
      WITH eligible AS MATERIALIZED (
        SELECT threads.thread_id
        FROM orchestration_v2_projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND (${projectId} IS NULL OR threads.project_id = ${projectId})
          AND json_extract(threads.payload_json, '$.lineage.relationshipToParent')
            IS NOT 'subagent'
      ),
      hits AS (
        ${
          match === null
            ? sql`
              SELECT
                messages.rowid AS message_rowid,
                messages.thread_id,
                messages.role,
                messages.created_at,
                messages.message_id,
                0 AS score
              FROM orchestration_v2_projection_messages AS messages
              WHERE ${indexedMessageCondition(sql)}
            `
            : sql`
              SELECT
                orchestration_v2_message_search.rowid AS message_rowid,
                messages.thread_id,
                messages.role,
                messages.created_at,
                messages.message_id,
                bm25(orchestration_v2_message_search) AS score
              FROM orchestration_v2_message_search
              INNER JOIN orchestration_v2_projection_messages AS messages
                ON messages.rowid = orchestration_v2_message_search.rowid
              WHERE orchestration_v2_message_search MATCH ${match}
            `
        }
          AND messages.thread_id IN eligible
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${substrings}) AS token
            WHERE instr(lower(json_extract(messages.payload_json, '$.text')), token.value) = 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${wordStarts}) AS token
            WHERE NOT (
              CASE
                WHEN instr(
                  lower(json_extract(messages.payload_json, '$.text')),
                  json_extract(token.value, '$.word')
                ) > 0
                THEN lower(json_extract(messages.payload_json, '$.text'))
                    GLOB json_extract(token.value, '$.word') || '*'
                  OR lower(json_extract(messages.payload_json, '$.text'))
                    GLOB '*[^a-z0-9]' || json_extract(token.value, '$.word') || '*'
                  OR json_extract(messages.payload_json, '$.text')
                    GLOB json_extract(token.value, '$.camel')
                ELSE EXISTS (
                  SELECT 1 FROM json_each(token.value, '$.accented') AS pattern
                  WHERE json_extract(messages.payload_json, '$.text') GLOB pattern.value
                )
              END
            )
          )
        -- Newest hits first, and only so many: a very common word stops early
        -- instead of checking every message. Hidden threads are already out.
        ORDER BY message_rowid DESC
        LIMIT ${MESSAGE_HIT_LIMIT}
      ),
      ranked AS (
        SELECT
          hits.*,
          MIN(score) OVER (PARTITION BY thread_id) AS thread_score,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              score ASC,
              created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM hits
      )
      SELECT
        ranked.thread_id AS "threadId",
        threads.project_id AS "projectId",
        ranked.role AS source,
        json_extract(messages.payload_json, '$.text') AS "matchText",
        ranked.created_at AS "messageCreatedAt"
      FROM ranked
      INNER JOIN orchestration_v2_projection_messages AS messages
        ON messages.rowid = ranked.message_rowid
      INNER JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = ranked.thread_id
      WHERE ranked.thread_match_rank = 1
      ORDER BY ranked.thread_score ASC, ranked.created_at DESC, ranked.thread_id ASC
      LIMIT ${limit}
    `,
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
    const rows = yield* read(
      Effect.gen(function* () {
        const index = yield* sql`
          SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
        `;
        const messageSearch = buildMessageSearch(input.query, index.length > 0);
        if (messageSearch === null) return [];
        return yield* searchRows({
          ...messageSearch,
          projectId: input.projectId,
          limit: input.limit ?? 50,
        });
      }),
    );
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, input.query),
        messageCreatedAt: row.messageCreatedAt,
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
    ).map(({ rank: _rank, ...match }) => ({
      ...match,
      title: subjectById.get(match.threadId)!.title,
    }));
    return { matches: [...titleHits, ...messageHits].slice(0, limit) };
  });

  return ThreadSearch.of({ search, searchThreads });
});

export const layer = Layer.effect(ThreadSearch, make);
