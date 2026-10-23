import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as GuestShareService from "./GuestShareService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
const hostname = Ref.makeUnsafe<string | null>("env.t3.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
    readyConnections: 1,
    hostname: value,
    protocol: "http2",
  })),
});
const layerTest = GuestShareService.layer.pipe(
  Layer.provideMerge(layerOrchestration),
  Layer.provide(layerConnect),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-guest-share-" })),
  Layer.provide(NodeServices.layer),
);

const threadId = ThreadId.make("thread:guest-share-service");

const shareThread = Effect.gen(function* () {
  yield* Ref.set(hostname, "env.t3.test");
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-guest-share-service"),
    threadId,
    projectId: ProjectId.make("project:guest-share-service"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const guestShares = yield* GuestShareService.GuestShareService;
  const { url } = yield* guestShares.create({ threadId });
  assert.isTrue(url.startsWith("https://env.t3.test/guest#"));
  const credential = url.slice(url.indexOf("#") + 1);
  return { orchestrator, guestShares, credential };
});

it.effect("spends an invite once and ends the guest stream when the owner stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const session = yield* guestShares.redeem({ credential, name: "Sam" });
    const again = yield* Effect.exit(guestShares.redeem({ credential, name: "Eve" }));
    assert.isTrue(Exit.isFailure(again));
    // An invite token is not a session token.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(credential))));

    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-guest-share"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    assert.deepEqual(
      received.map((event) => event.type),
      ["snapshot", "ended"],
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses guest requests once T3 Connect no longer serves the link's host", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const session = yield* guestShares.redeem({ credential, name: "Sam" });
    yield* Ref.set(hostname, null);
    const submitted = yield* Effect.exit(guestShares.submit(session, { text: "Hello" }));
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);
