import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly subagentOf?: ThreadId;
    readonly title?: string;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: overrides.title ?? threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: overrides.subagentOf
      ? {
          parentThreadId: overrides.subagentOf,
          relationshipToParent: "subagent",
          rootThreadId: overrides.subagentOf,
        }
      : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: {
    readonly minute?: number;
    readonly streaming?: boolean;
    readonly createdBy?: "user" | "agent";
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: options.createdBy ?? (role === "user" ? "user" : "agent"),
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("reads the newest hits without sorting all of them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const match of ['"needle"', null]) {
        const plan = yield* sql<{
          readonly detail: string;
        }>`EXPLAIN QUERY PLAN ${ThreadSearch.messageHitsQuery(sql, { match, substrings: "[]", projectId: null, excludedThreadIds: "[]" })}`;
        assert.isFalse(
          plan.some((row) => row.detail.includes("TEMP B-TREE")),
          plan.map((row) => row.detail).join("\n"),
        );
      }
    }),
  );

  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches
          .map((match) => [match.threadId, match.source, match.snippet])
          .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
        [
          [assistantOnly, "assistant", "needle in an answer"],
          [both, "user", "newer needle question"],
        ],
      );
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );

  it.effect("indexes a message when it finishes streaming and follows later edits", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-sync");
      const threadId = ThreadId.make("thread:sync");
      yield* createProject(project);
      yield* projections.apply(thread(threadId, project));
      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));

      yield* projections.apply(
        message(threadId, "sync", "assistant", "streaming draft", { streaming: true }),
      );
      assert.deepEqual(yield* threadIds("draft"), []);

      yield* projections.apply(message(threadId, "sync", "assistant", "finished answer"));
      assert.deepEqual(yield* threadIds("finished"), [threadId]);

      yield* projections.apply(message(threadId, "sync", "assistant", "edited reply"));
      assert.deepEqual(yield* threadIds("finished"), []);
      assert.deepEqual(yield* threadIds("edited"), [threadId]);
    }),
  );

  it.effect("matches inside identifiers and skips subagent threads and short tokens", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-tokens");
      const parent = ThreadId.make("thread:tokens-parent");
      const subagent = ThreadId.make("thread:tokens-subagent");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          message(parent, "parent", "user", "Rename ThreadSearchService before shipping"),
          thread(subagent, project, { subagentOf: parent }),
          message(subagent, "subagent", "assistant", "ThreadSearchService renamed"),
        ],
        projections.apply,
        { discard: true },
      );

      const result = yield* search.search({ query: "search servi" });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.snippet]),
        [[parent, "Rename ThreadSearchService before shipping"]],
      );
      // "ab" alone cannot use the index; with a longer token it narrows the hits.
      assert.deepEqual((yield* search.search({ query: "ab" })).matches, []);
      assert.lengthOf((yield* search.search({ query: "renam be" })).matches, 1);
      assert.lengthOf((yield* search.search({ query: "renam ab" })).matches, 0);
    }),
  );
});

it.layer(layerTest)("ThreadSearch filters before it ranks", (it) => {
  it.effect("finds older words when the newest hits only hold the fragment inside words", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:fragments");
      yield* createProject(project);
      const older = [
        ["start", "Ingest the logs first"],
        ["newline", "Plan:\ningest the logs"],
        ["paren", "Run the job (ingest only)"],
        ["space", "Then ingest the logs"],
      ] as const;
      const busy = ThreadId.make("thread:fragment-busy");
      yield* Effect.forEach(
        [
          ...older.flatMap(([key, text]) => [
            thread(ThreadId.make(`thread:fragment-${key}`), project),
            message(ThreadId.make(`thread:fragment-${key}`), `fragment-${key}`, "user", text),
          ]),
          thread(busy, project),
          ...Array.from({ length: 2000 }, (_, index) =>
            message(busy, `fragment-busy-${index}`, "assistant", "still working on it"),
          ),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "ing" });
      assert.sameMembers(
        matches.map((match) => match.threadId),
        older.map(([key]) => ThreadId.make(`thread:fragment-${key}`)),
      );
    }),
  );

  it.effect("orders message matches by when they were written, not by row order", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:written");
      yield* createProject(project);
      const recent = ThreadId.make("thread:written-recent");
      const imported = ThreadId.make("thread:written-imported");
      // An imported history lands after newer messages in row order.
      yield* Effect.forEach(
        [
          thread(recent, project),
          message(recent, "written-recent", "user", "kestrel deploy notes", { minute: 30 }),
          thread(imported, project),
          message(imported, "written-imported", "user", "kestrel deploy notes", { minute: 1 }),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "kestrel" });
      assert.deepEqual(
        matches.map((match) => match.threadId),
        [recent, imported],
      );
    }),
  );

  it.effect("finds an older word when one busy thread fills the newest hits", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:busy-word");
      yield* createProject(project);
      const older = ThreadId.make("thread:rust-word");
      const busy = ThreadId.make("thread:rustling");
      yield* Effect.forEach(
        [
          thread(older, project),
          message(older, "rust-word", "user", "Rust migration rationale"),
          thread(busy, project),
          ...Array.from({ length: 2000 }, (_, index) =>
            message(busy, `rustling-${index}`, "assistant", "rustling leaves outside"),
          ),
        ],
        projections.apply,
        { discard: true },
      );
      const { matches } = yield* search.search({ query: "rust" });
      assert.deepEqual(
        matches.map((match) => match.threadId),
        [older, busy],
      );
    }),
  );

  it.effect("finds a visible match behind hundreds of hidden or narrower hits", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:crowded");
      const parent = ThreadId.make("thread:crowded-parent");
      const subagent = ThreadId.make("thread:crowded-subagent");
      const older = ThreadId.make("thread:crowded-older");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          thread(subagent, project, { subagentOf: parent }),
          thread(older, project),
          ...Array.from({ length: 450 }, (_, index) =>
            message(subagent, `subagent-${index}`, "assistant", "needle needle"),
          ),
          ...Array.from({ length: 450 }, (_, index) =>
            message(older, `older-${index}`, "assistant", "pnpm 11 pnpm"),
          ),
          message(parent, "parent-needle", "user", "a needle in a long haystack of other words"),
          // Agent-written notices in user messages are not indexed, so they never read as "You".
          message(older, "older-notice", "user", "needle update from a watched pull request", {
            createdBy: "agent",
          }),
          message(parent, "parent-pnpm", "user", "moved the repo to pnpm 12 today"),
        ],
        projections.apply,
        { discard: true },
      );

      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));
      assert.deepEqual(yield* threadIds("needle"), [parent]);
      assert.deepEqual(yield* threadIds("pnpm 12"), [parent]);
    }),
  );
});

it.layer(layerTest)("ThreadSearch across scripts and without the index", (it) => {
  it.effect(
    "matches Korean, Japanese, and two-character Chinese words, and whole short words",
    () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const search = yield* ThreadSearch.ThreadSearch;
        const sql = yield* SqlClient.SqlClient;
        const project = ProjectId.make("project:scripts");
        const threadId = ThreadId.make("thread:scripts");
        const drafts = ThreadId.make("thread:drafts");
        const addresses = ThreadId.make("thread:addresses");
        yield* createProject(project);
        yield* Effect.forEach(
          [
            thread(threadId, project),
            message(threadId, "korean", "user", "검색 기능을 고쳐 주세요"),
            message(threadId, "japanese", "user", "がんばって検索します"),
            message(threadId, "chinese", "user", "明天部署到生产环境"),
            message(threadId, "fts", "assistant", "the FTS index is ready"),
            thread(drafts, project),
            message(drafts, "drafts", "assistant", "saved two drafts and shifts"),
            message(threadId, "camel", "assistant", "Configure enableFTS today"),
            message(threadId, "accented", "user", "Review Résumé indexing"),
            thread(addresses, project),
            message(addresses, "addresses", "user", "This addresses Résumé indexing"),
            message(threadId, "spelled", "user", "Die Straße ist lang"),
          ],
          projections.apply,
          { discard: true },
        );
        const threadIds = (query: string) =>
          search
            .search({ query })
            .pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));

        // Short words must start a word, which camelCase and accented words do.
        for (const query of ["검색 기능", "がんばって", "部署", "fts", "enable"]) {
          assert.deepEqual(yield* threadIds(query), [threadId], query);
        }
        // Letters the index spells out match either way they are typed.
        assert.deepEqual(yield* threadIds("strasse"), [threadId]);
        assert.deepEqual(yield* threadIds("straße"), [threadId]);
        // "res" inside "addresses" does not hide the accented word after it.
        assert.sameMembers(yield* threadIds("res"), [threadId, addresses]);
        // A word beats the same letters inside a longer word, even in an older message.
        const trust = ThreadId.make("thread:trust");
        const rust = ThreadId.make("thread:rust");
        yield* Effect.forEach(
          [
            thread(rust, project),
            message(rust, "rust", "assistant", "Rust rewrite notes"),
            thread(trust, project),
            message(trust, "trust", "user", "We trust the build"),
          ],
          projections.apply,
          { discard: true },
        );
        const { matches } = yield* search.search({ query: "rust" });
        assert.deepEqual(
          matches.map((match) => [match.threadId, match.midWord ?? false]),
          [
            [rust, false],
            [trust, true],
          ],
        );
        // Without the index (an SQLite build without FTS5 trigrams) search scans instead.
        yield* sql`DROP TABLE orchestration_v2_message_search`;
        assert.deepEqual(yield* threadIds("検索"), [threadId]);
        assert.deepEqual(yield* threadIds("fts"), [threadId]);
      }),
  );
});

it.layer(layerTest)("ThreadSearch.searchThreads", (it) => {
  it.effect("ranks title matches like the palette, then message matches, within one project", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:titles");
      const otherProject = ProjectId.make("project:titles-other");
      yield* createProject(project);
      yield* createProject(otherProject);
      const wordStart = ThreadId.make("thread:word-start");
      const midWord = ThreadId.make("thread:mid-word");
      const messageOnly = ThreadId.make("thread:message-only");
      const elsewhere = ThreadId.make("thread:elsewhere");
      yield* Effect.forEach(
        [
          thread(midWord, project, { title: "Fix oauth redirect" }),
          thread(wordStart, project, { title: "Clean up auth tokens" }),
          thread(messageOnly, project, { title: "Unrelated" }),
          message(messageOnly, "message-only", "user", "the auth flow broke again"),
          thread(elsewhere, otherProject, { title: "Auth everywhere" }),
        ],
        projections.apply,
        { discard: true },
      );

      // Stronger message hits in another project must not use up this project's limit.
      yield* Effect.forEach(
        Array.from({ length: 55 }, (_, index) => {
          const busy = ThreadId.make(`thread:elsewhere-${index}`);
          return [
            thread(busy, otherProject),
            message(busy, `elsewhere-${index}`, "user", "auth auth auth"),
          ];
        }).flat(),
        projections.apply,
        { discard: true },
      );
      const result = yield* search.searchThreads({ query: "auth", projectId: project, limit: 3 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source]),
        [
          [wordStart, "title"],
          [midWord, "title"],
          [messageOnly, "user"],
        ],
      );
      // Exact matching finds nothing, so one typo is forgiven.
      assert.deepEqual(
        (yield* search.searchThreads({ query: "tokesn", projectId: project })).matches.map(
          (match) => match.title,
        ),
        ["Clean up auth tokens"],
      );
    }),
  );
});

it.effect("starts snippets a few words before the match so one line shows it", () =>
  Effect.sync(() => {
    const snippet = (text: string, word: string) =>
      ThreadSearch.buildSearchSnippet(text, text.indexOf(word));
    const long = `${"lead ".repeat(60)}the NEEDLE sits here ${"tail ".repeat(60)}`;
    const cut = snippet(long, "NEEDLE");
    assert.isAtMost(cut.length, 240);
    assert.match(cut, /^…(lead ){2,4}the NEEDLE sits here/);
    assert.isTrue(cut.endsWith("…"));
    // Whitespace collapses only in the shown part, so the offset still lands.
    assert.match(snippet(`${"word\n\n  ".repeat(60)}un café`, "café"), /un café$/);
    // A cut never splits an emoji's surrogate pair.
    assert.notMatch(
      snippet(`x${"🚀".repeat(200)}needle`, "needle"),
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
    // Short text still moves a late match into view.
    assert.equal(snippet(`${"word ".repeat(20)}needle`, "needle"), "…word word word word needle");
  }),
);

it.effect("searches on the reader worker while the writer is busy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-search-" });
    const layerFile = Layer.mergeAll(
      ThreadSearch.layer,
      ProjectionStore.layer,
      ProjectStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-reader");
      const threadId = ThreadId.make("thread:reader");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "reader", "user", "needle on the reader")],
        projections.apply,
        { discard: true },
      );

      const writerHeld = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(writerHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        ),
      );
      yield* Deferred.await(writerHeld);
      const result = yield* search.search({ query: "needle" });
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      assert.deepEqual(
        result.matches.map((match) => match.threadId),
        [threadId],
      );
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
