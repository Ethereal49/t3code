import {
  CommandId,
  GUEST_SHARE_TTL_MS,
  GuestMessageId,
  GuestShareCreateError,
  type GuestShareCreateInput,
  type GuestShareCreateResult,
  GuestShareId,
  type GuestRedeemRequest,
  type GuestStreamEvent,
  type GuestSubmitRequest,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  guestItemEvent,
  guestItemText,
  guestShareView,
  guestTranscriptItem,
  isGuestVisibleRun,
} from "./guestTranscript.ts";

const SIGNING_SECRET_NAME = "guest-share-signing-key";
const SNAPSHOT_ROW_LIMIT = 600;
const HOST_RECHECK_INTERVAL = Duration.seconds(30);
const SNAPSHOT_USER_TURN_LIMIT = 20;
const WORKING_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export class GuestShareAccessError extends Schema.TaggedError<GuestShareAccessError>()(
  "GuestShareAccessError",
  {
    reason: Schema.Literals(["invalid", "inactive", "rejected"]),
    message: Schema.String,
  },
) {}

const TokenClaims = Schema.Struct({
  kind: Schema.Literals(["invite", "session"]),
  threadId: ThreadId,
  shareId: GuestShareId,
});
type TokenClaims = typeof TokenClaims.Type;
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(TokenClaims));

const inactive = new GuestShareAccessError({
  reason: "inactive",
  message: "This guest link is no longer active.",
});

export class GuestShareService extends Context.Service<
  GuestShareService,
  {
    readonly create: (
      input: GuestShareCreateInput,
    ) => Effect.Effect<GuestShareCreateResult, GuestShareCreateError>;
    /** Spends an invite and returns the session token for the guest's cookie. */
    readonly redeem: (request: GuestRedeemRequest) => Effect.Effect<string, GuestShareAccessError>;
    readonly submit: (
      session: string,
      request: GuestSubmitRequest,
    ) => Effect.Effect<void, GuestShareAccessError>;
    readonly stream: (
      session: string,
    ) => Effect.Effect<Stream.Stream<GuestStreamEvent>, GuestShareAccessError>;
  }
>()("t3/guest/GuestShareService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingKey = yield* Effect.cached(
    secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
  );

  // Tokens are derived from the share id, so nothing secret is stored and replacing or closing
  // the share in the thread projection revokes every token for it.
  const sign = (claims: TokenClaims) =>
    Effect.map(signingKey, (key) => {
      const payload = base64UrlEncode(JSON.stringify(claims));
      return `${payload}.${signPayload(payload, key)}`;
    });
  const verify = (token: string, kind: TokenClaims["kind"]) =>
    Effect.map(signingKey, (key) => {
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) return Option.none<TokenClaims>();
      if (!timingSafeEqualBase64Url(signature, signPayload(payload, key))) {
        return Option.none<TokenClaims>();
      }
      return decodeClaims(base64UrlDecodeUtf8(payload)).pipe(
        Option.filter((claims) => claims.kind === kind),
      );
    });

  const connectHostname = managedEndpoint.inspectConnector.pipe(
    Effect.map((facts) => facts?.hostname ?? null),
  );

  const dispatchGuestCommand = (
    command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
  ) =>
    orchestrator.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new GuestShareAccessError({
            reason: "rejected",
            message:
              "cause" in cause && typeof cause.cause === "string"
                ? cause.cause
                : "The owner's server rejected this request.",
          }),
      ),
    );

  const commandId = (label: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => CommandId.make(`server:guest-share:${label}:${uuid}`)),
      Effect.orDie,
    );

  /** Checks a token against the live share: same id, not expired, and Connect still serving it. */
  const authorize = Effect.fn("GuestShareService.authorize")(function* (
    token: string,
    kind: TokenClaims["kind"],
  ) {
    const claims = yield* verify(token, kind);
    if (Option.isNone(claims)) {
      return yield* new GuestShareAccessError({
        reason: "invalid",
        message: "This guest link is not valid.",
      });
    }
    const { thread } = yield* orchestrator
      .getThreadRecords(claims.value.threadId, [])
      .pipe(Effect.mapError(() => inactive));
    const share = thread.guestShare;
    const now = yield* DateTime.now;
    if (
      !share ||
      share.id !== claims.value.shareId ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      DateTime.toEpochMillis(now) >= Date.parse(share.expiresAt) ||
      (kind === "session" && share.guestName === null) ||
      (yield* connectHostname) !== share.host
    ) {
      return yield* inactive;
    }
    return { thread, share };
  });

  const create = Effect.fn("GuestShareService.create")(function* (input: GuestShareCreateInput) {
    const host = yield* connectHostname;
    if (host === null) {
      return yield* new GuestShareCreateError({
        reason: "connect_unavailable",
        message: "Guest links need a running T3 Connect tunnel.",
      });
    }
    const shareId = GuestShareId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const now = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(DateTime.add(now, { milliseconds: GUEST_SHARE_TTL_MS }));
    yield* orchestrator
      .dispatch({
        type: "thread.guest-share.open",
        commandId: yield* commandId("open"),
        threadId: input.threadId,
        shareId,
        host,
        expiresAt,
      })
      .pipe(
        Effect.mapError(
          () =>
            new GuestShareCreateError({
              reason: "thread_unavailable",
              message: "This thread cannot be shared.",
            }),
        ),
      );
    const { thread } = yield* orchestrator.getThreadRecords(input.threadId, []).pipe(
      Effect.mapError(
        () =>
          new GuestShareCreateError({
            reason: "internal",
            message: "Failed to read the shared thread.",
          }),
      ),
    );
    if (!thread.guestShare || thread.guestShare.id !== shareId) {
      return yield* new GuestShareCreateError({
        reason: "internal",
        message: "The guest link changed while it was being created.",
      });
    }
    const credential = yield* sign({ kind: "invite", threadId: input.threadId, shareId });
    return { url: `https://${host}/guest#${credential}`, share: thread.guestShare };
  });

  const redeem = Effect.fn("GuestShareService.redeem")(function* (request: GuestRedeemRequest) {
    const { thread, share } = yield* authorize(request.credential, "invite");
    yield* dispatchGuestCommand({
      type: "thread.guest-share.redeem",
      commandId: yield* commandId("redeem"),
      threadId: thread.id,
      shareId: share.id,
      guestName: request.name,
    });
    return yield* sign({ kind: "session", threadId: thread.id, shareId: share.id });
  });

  const submit = Effect.fn("GuestShareService.submit")(function* (
    session: string,
    request: GuestSubmitRequest,
  ) {
    const { thread, share } = yield* authorize(session, "session");
    yield* dispatchGuestCommand({
      type: "thread.guest-message.submit",
      commandId: yield* commandId("submit"),
      threadId: thread.id,
      shareId: share.id,
      guestMessageId: GuestMessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      text: request.text,
    });
  });

  const stream = Effect.fn("GuestShareService.stream")(function* (session: string) {
    const { thread: authorizedThread, share } = yield* authorize(session, "session");
    const snapshot = yield* orchestrator
      .getThreadSnapshotWindow(authorizedThread.id, {
        rowLimit: SNAPSHOT_ROW_LIMIT,
        userTurnLimit: SNAPSHOT_USER_TURN_LIMIT,
      })
      .pipe(Effect.mapError(() => inactive));
    const { projection } = snapshot;
    if (projection.thread.guestShare?.id !== share.id) return yield* inactive;

    const runStatuses = new Map<RunId, OrchestrationV2Run["status"]>();
    for (const run of projection.runs) {
      if (isGuestVisibleRun(run, share.historyStartRunOrdinal)) runStatuses.set(run.id, run.status);
    }
    const texts = new Map<string, string>();
    const items = projection.visibleTurnItems.flatMap((entry) => {
      if (entry.visibility !== "local" || entry.item.runId === null) return [];
      if (!runStatuses.has(entry.item.runId)) return [];
      const item = guestTranscriptItem(entry.item);
      if (item === null) return [];
      const text = guestItemText(item);
      if (text !== undefined) texts.set(item.id, text);
      return [item];
    });
    const working = () =>
      [...runStatuses.values()].some((status) => WORKING_RUN_STATUSES.has(status));
    let thread: OrchestrationV2AppThread = projection.thread;
    const view = () => guestShareView(thread, working());
    const initialView = view();
    if (initialView === null) return yield* inactive;

    const ended: GuestStreamEvent = { type: "ended" };
    const live = orchestrator
      .streamStoredEventsFrom({ threadId: thread.id, afterSequence: snapshot.snapshotSequence })
      .pipe(
        Stream.map((stored): ReadonlyArray<GuestStreamEvent> => {
          const event = stored.event;
          switch (event.type) {
            case "run.created":
            case "run.updated": {
              if (!isGuestVisibleRun(event.payload, share.historyStartRunOrdinal)) return [];
              const wasWorking = working();
              runStatuses.set(event.payload.id, event.payload.status);
              const next = view();
              return wasWorking === working() || next === null
                ? []
                : [{ type: "view", view: next }];
            }
            case "turn-item.updated": {
              const runId = event.payload.runId;
              if (runId === null || !runStatuses.has(runId)) return [];
              const item = guestTranscriptItem(event.payload);
              if (item === null) return [];
              const update = guestItemEvent(texts.get(item.id), item);
              const text = guestItemText(item);
              if (text !== undefined) texts.set(item.id, text);
              return [update];
            }
            case "thread.archived":
            case "thread.deleted":
              return [ended];
            case "thread.guest-share-updated":
            case "thread.metadata-updated": {
              thread = event.payload;
              if (thread.guestShare?.id !== share.id) return [ended];
              const next = view();
              return next === null ? [ended] : [{ type: "view", view: next }];
            }
            default:
              return [];
          }
        }),
        Stream.flattenIterable,
        Stream.takeUntil((event) => event.type === "ended"),
        Stream.catchCause(() => Stream.make(ended)),
      );
    const untilExpiry = Effect.sleep(
      Math.max(0, Date.parse(share.expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)),
    );
    // Unlinking T3 Connect must also end streams that are already open.
    const untilHostLost = connectHostname.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(HOST_RECHECK_INTERVAL),
        until: (current) => current !== share.host,
      }),
    );
    const snapshotEvent: GuestStreamEvent = { type: "snapshot", view: initialView, items };
    return Stream.concat(
      Stream.make(snapshotEvent),
      Stream.concat(
        live.pipe(Stream.interruptWhen(Effect.race(untilExpiry, untilHostLost))),
        Stream.make(ended),
      ),
    ).pipe(Stream.takeUntil((event) => event.type === "ended"));
  });

  return GuestShareService.of({ create, redeem, submit, stream });
});

export const layer = Layer.effect(GuestShareService, make);
