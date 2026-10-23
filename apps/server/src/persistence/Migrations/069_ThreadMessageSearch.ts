import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Full-text index for thread message search. The trigram tokenizer matches any
 * substring of three or more characters, ignoring case and accents, so
 * identifiers inside code still match, without the full-table scan a
 * `LIKE '%q%'` needs.
 *
 * It holds what the user wrote and what agents answered. User-role messages
 * that agents or the system wrote (pull request updates, task notices) would
 * flood results and read as "You".
 *
 * The index is contentless and keyed by the message rowid: search reads the
 * text back from the message row, so the text is not stored twice. `t3 doctor`
 * rebuilds it after its VACUUM, since SQLite does not promise to keep rowids.
 *
 * Triggers keep it in sync with every write to the messages table. Streaming
 * messages are indexed once they finish.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram remove_diacritics 1'
    )
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_search_insert
    AFTER INSERT ON orchestration_v2_projection_messages
    WHEN new.streaming = 0
      AND (
        new.role = 'assistant'
        OR (new.role = 'user' AND COALESCE(json_extract(new.payload_json, '$.createdBy'), 'user') = 'user')
      )
    BEGIN
      INSERT INTO orchestration_v2_message_search (rowid, text)
      SELECT new.rowid, json_extract(new.payload_json, '$.text')
      WHERE json_extract(new.payload_json, '$.text') IS NOT NULL;
    END
  `;
  // Streaming deltas rewrite the row many times a second; skip them until the
  // message settles. Deleting a rowid the index never held is a no-op.
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_search_update
    AFTER UPDATE OF payload_json, streaming, role ON orchestration_v2_projection_messages
    WHEN old.streaming = 0 OR new.streaming = 0
    BEGIN
      DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid AND old.streaming = 0;
      INSERT INTO orchestration_v2_message_search (rowid, text)
      SELECT new.rowid, json_extract(new.payload_json, '$.text')
      WHERE new.streaming = 0
        AND (
          new.role = 'assistant'
          OR (new.role = 'user' AND COALESCE(json_extract(new.payload_json, '$.createdBy'), 'user') = 'user')
        )
        AND json_extract(new.payload_json, '$.text') IS NOT NULL;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_search_delete
    AFTER DELETE ON orchestration_v2_projection_messages
    WHEN old.streaming = 0
    BEGIN
      DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
    END
  `;
  yield* sql`
    INSERT INTO orchestration_v2_message_search (rowid, text)
    SELECT rowid, json_extract(payload_json, '$.text')
    FROM orchestration_v2_projection_messages
    WHERE streaming = 0
      AND (
        role = 'assistant'
        OR (role = 'user' AND COALESCE(json_extract(payload_json, '$.createdBy'), 'user') = 'user')
      )
      AND json_extract(payload_json, '$.text') IS NOT NULL
  `;
});
