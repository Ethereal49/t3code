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
