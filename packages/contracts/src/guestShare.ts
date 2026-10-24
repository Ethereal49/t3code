import * as Schema from "effect/Schema";

import {
  GuestMessageId,
  GuestShareId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * A guest share lets one unauthenticated browser watch a thread over T3 Connect and propose
 * messages the owner must send or dismiss. The thread projection holds this public state; the
 * credentials are derived from the share id with a server key and never stored.
 */
export const GUEST_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_MESSAGE_MAX_LENGTH = 4_000;
export const GUEST_NAME_MAX_LENGTH = 40;
export const GUEST_PENDING_MESSAGE_LIMIT = 3;
/** Resolved messages kept so the guest can see what happened to what they sent. */
export const GUEST_RESOLVED_MESSAGE_LIMIT = 20;
/** Completed runs before the invite that the guest can read. */
export const GUEST_SHARE_HISTORY_RUNS = 3;

export const ThreadGuestMessageStatus = Schema.Literals(["pending", "sent", "dismissed"]);
export type ThreadGuestMessageStatus = typeof ThreadGuestMessageStatus.Type;

export const ThreadGuestMessage = Schema.Struct({
  id: GuestMessageId,
  text: Schema.String,
  status: ThreadGuestMessageStatus,
  submittedAt: IsoDateTime,
});
export type ThreadGuestMessage = typeof ThreadGuestMessage.Type;

export const ThreadGuestShare = Schema.Struct({
  id: GuestShareId,
  /** The T3 Connect tunnel hostname the link points at. Guest routes require it to still serve. */
  host: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** Runs with a lower ordinal stay hidden from the guest. */
  historyStartRunOrdinal: NonNegativeInt,
  /** Set once, when the guest redeems the link. */
  guestName: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ThreadGuestMessage),
});
export type ThreadGuestShare = typeof ThreadGuestShare.Type;

/** The server keeps an expired share so pending messages stay resolvable; clients label it. */
export const isGuestShareExpired = (share: ThreadGuestShare, nowMs: number): boolean =>
  nowMs >= Date.parse(share.expiresAt);

export const pendingGuestMessageCount = (share: ThreadGuestShare | null | undefined): number =>
  share?.messages.filter((message) => message.status === "pending").length ?? 0;

export const GuestShareCreateInput = Schema.Struct({ threadId: ThreadId });
export type GuestShareCreateInput = typeof GuestShareCreateInput.Type;

export const GuestShareCreateResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  share: ThreadGuestShare,
});
export type GuestShareCreateResult = typeof GuestShareCreateResult.Type;

export class GuestShareCreateError extends Schema.TaggedError<GuestShareCreateError>()(
  "GuestShareCreateError",
  {
    reason: Schema.Literals(["connect_unavailable", "thread_unavailable", "internal"]),
    message: Schema.String,
  },
) {}

export const GuestRedeemRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(GUEST_NAME_MAX_LENGTH)),
});
export type GuestRedeemRequest = typeof GuestRedeemRequest.Type;

export const GuestSubmitRequest = Schema.Struct({
  /** The share the page shows. One cookie serves every link on a host, so a newer link redeemed
      in another tab must not receive this page's message. */
  shareId: GuestShareId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(GUEST_MESSAGE_MAX_LENGTH)),
});
export type GuestSubmitRequest = typeof GuestSubmitRequest.Type;

/** Only these kinds ever reach a guest. Everything else in a thread is dropped on the server. */
export const GuestTranscriptItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["user", "assistant", "plan"]),
    id: TrimmedNonEmptyString,
    text: Schema.String,
    streaming: Schema.Boolean,
    /** Set on a user message a guest wrote. Earlier links' guests show by name, not as "You". */
    guestMessageId: Schema.optional(GuestMessageId),
    guestName: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("question"),
    id: TrimmedNonEmptyString,
    questions: Schema.Array(
      Schema.Struct({
        header: Schema.String,
        question: Schema.String,
        options: Schema.Array(Schema.String),
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    id: TrimmedNonEmptyString,
    label: Schema.String,
  }),
]);
export type GuestTranscriptItem = typeof GuestTranscriptItem.Type;

export const GuestShareView = Schema.Struct({
  shareId: GuestShareId,
  title: Schema.String,
  guestName: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  working: Schema.Boolean,
  messages: Schema.Array(ThreadGuestMessage),
});
export type GuestShareView = typeof GuestShareView.Type;

export const GuestStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    view: GuestShareView,
    items: Schema.Array(GuestTranscriptItem),
  }),
  Schema.Struct({ type: Schema.Literal("item"), item: GuestTranscriptItem }),
  /** Streaming text grows by `append` when the new text extends the old one. */
  Schema.Struct({
    type: Schema.Literal("append"),
    id: TrimmedNonEmptyString,
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("view"), view: GuestShareView }),
  Schema.Struct({ type: Schema.Literal("ended") }),
]);
export type GuestStreamEvent = typeof GuestStreamEvent.Type;

export const GUEST_ROUTE_PREFIX = "/api/guest";
export const GUEST_SESSION_COOKIE = "t3_guest";
