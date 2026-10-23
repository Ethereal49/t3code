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
  normalizeSearchQuery,
  rankMessageMatches,
  rankSearchItems,
  scoreThreadSearch,
  type ThreadSearchSubject,
} from "@t3tools/shared/searchRank";
import { threadSearchPullRequests } from "@t3tools/shared/threadPullRequests";

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

const SearchRequest = Schema.Struct({
  match: Schema.String,
  // A JSON array in SQL, so any number of short tokens binds as one parameter.
  shortTokens: Schema.fromJsonString(Schema.Array(Schema.String)),
  limit: Schema.Int,
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

// The trigram index cannot match tokens shorter than three characters. They
// only narrow the indexed matches ("pnpm 12"); alone, a two-letter substring
// of a message is noise rather than a match.
const MIN_TOKEN_LENGTH = 3;
const SNIPPET_LENGTH = 240;

/**
 * Every long-enough token as a quoted FTS5 phrase, so all must appear, and the
 * shorter tokens for a substring check on the hits.
 */
function buildMessageSearch(
  query: string,
): { readonly match: string; readonly shortTokens: ReadonlyArray<string> } | null {
  const tokens = normalizeSearchQuery(query).split(" ");
  const long = tokens.filter((token) => [...token].length >= MIN_TOKEN_LENGTH);
  if (long.length === 0) return null;
  return {
    match: long.map((token) => `"${token.replaceAll('"', '""')}"`).join(" "),
    shortTokens: tokens.filter((token) => token.length > 0 && !long.includes(token)),
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
  const lowerText = normalizedText.toLowerCase();
  const matchStarts = normalizeSearchQuery(query)
    .split(" ")
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
    .map((token) => lowerText.indexOf(token))
    .filter((index) => index !== -1);
  const matchStart = matchStarts.length === 0 ? 0 : Math.min(...matchStarts);
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
  // their best bm25 hit. Every palette and sidebar hides subagent threads, so
  // their messages would only use up the limit. Filters apply before ranking,
  // so hidden threads never crowd out a visible match, and message bodies are
  // read only for the winners.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ match, shortTokens, limit }) => sql`
      WITH eligible AS MATERIALIZED (
        SELECT threads.thread_id
        FROM orchestration_v2_projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND json_extract(threads.payload_json, '$.lineage.relationshipToParent')
            IS NOT 'subagent'
      ),
      hits AS (
        SELECT
          messages.rowid AS message_rowid,
          messages.thread_id,
          messages.role,
          messages.created_at,
          messages.message_id,
          bm25(orchestration_v2_message_search) AS score
        FROM orchestration_v2_message_search
        INNER JOIN orchestration_v2_projection_messages AS messages
          ON messages.rowid = orchestration_v2_message_search.rowid
        WHERE orchestration_v2_message_search MATCH ${match}
          AND messages.thread_id IN eligible
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${shortTokens}) AS token
            WHERE instr(lower(json_extract(messages.payload_json, '$.text')), token.value) = 0
          )
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

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const messageSearch = buildMessageSearch(input.query);
      if (messageSearch === null) return { matches: [] };
      const rows = yield* read(
        searchRows({
          match: messageSearch.match,
          shortTokens: messageSearch.shortTokens,
          limit: input.limit ?? 50,
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
    },
  );

  const searchThreads: ThreadSearch["Service"]["searchThreads"] = Effect.fn(
    "ThreadSearch.searchThreads",
  )(function* (input) {
    const limit = input.limit ?? 50;
    const normalizedQuery = normalizeSearchQuery(input.query);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
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
          activityAt: row.latestUserMessageAt === null ? null : Date.parse(row.latestUserMessageAt),
          opens: row.thread.opens
            ? { ...row.thread.opens, openedAt: DateTime.toEpochMillis(row.thread.opens.openedAt) }
            : null,
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
    const { matches } = yield* search({ query: input.query, limit: 50 });
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
