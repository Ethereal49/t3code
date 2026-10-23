import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The messages that migration 69's triggers index for search, for queries
 * that must agree with it: finished, and either written by the user or
 * answered by an agent. User-role notices that agents or the system wrote
 * stay out. Expects the messages table aliased as `messages`.
 */
export const indexedMessageCondition = (sql: SqlClient.SqlClient) => sql`
  messages.streaming = 0
  AND (
    messages.role = 'assistant'
    OR (
      messages.role = 'user'
      AND COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user'
    )
  )
`;

/**
 * Refills the search index from the messages table. The index is keyed by
 * message rowid, so anything that may renumber or copy rows (VACUUM, a dev
 * database copy) rebuilds it instead of trusting it. Databases from before
 * migration 69, or on an SQLite without FTS5 trigrams, have no index.
 */
export const rebuildMessageSearch = Effect.fn("MessageSearchIndex.rebuild")(function* (
  sql: SqlClient.SqlClient,
) {
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;
  yield* sql`
    INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
    VALUES ('delete-all')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_message_search (rowid, text)
    SELECT messages.rowid, ' ' || json_extract(messages.payload_json, '$.text')
    FROM orchestration_v2_projection_messages AS messages
    WHERE ${indexedMessageCondition(sql)}
      AND json_extract(messages.payload_json, '$.text') IS NOT NULL
  `;
});
