import {
  GuestStreamEvent,
  type GuestMessageId,
  type GuestShareView,
  type GuestTranscriptItem,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface GuestStreamState {
  readonly view: GuestShareView | null;
  readonly items: ReadonlyArray<GuestTranscriptItem>;
  readonly ended: boolean;
  /** Messages this page has seen waiting. Survives reconnects; see `unplacedGuestMessages`. */
  readonly seenPendingIds: ReadonlySet<GuestMessageId>;
}

export const initialGuestStreamState: GuestStreamState = {
  view: null,
  items: [],
  ended: false,
  seenPendingIds: new Set(),
};

function withSeenPending(
  seen: ReadonlySet<GuestMessageId>,
  view: GuestShareView,
): ReadonlySet<GuestMessageId> {
  const pending = view.messages.filter((message) => message.status === "pending");
  if (pending.every((message) => seen.has(message.id))) return seen;
  return new Set([...seen, ...pending.map((message) => message.id)]);
}

const decodeGuestStreamEvent = Schema.decodeUnknownOption(Schema.fromJsonString(GuestStreamEvent));

/** Returns null for anything the server would never send, so a bad frame is skipped, not fatal. */
export const parseGuestStreamEvent = (data: string): GuestStreamEvent | null =>
  Option.getOrNull(decodeGuestStreamEvent(data));

/**
 * A reconnect starts with a fresh snapshot, so `snapshot` replaces everything and later events
 * only patch what it delivered.
 */
export function applyGuestStreamEvent(
  state: GuestStreamState,
  event: GuestStreamEvent,
): GuestStreamState {
  switch (event.type) {
    case "snapshot":
      return {
        view: event.view,
        items: event.items,
        ended: false,
        seenPendingIds: withSeenPending(state.seenPendingIds, event.view),
      };
    case "item": {
      const exists = state.items.some((item) => item.id === event.item.id);
      return {
        ...state,
        items: exists
          ? state.items.map((item) => (item.id === event.item.id ? event.item : item))
          : [...state.items, event.item],
      };
    }
    case "append":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === event.id && "text" in item
            ? { ...item, text: item.text + event.text, streaming: event.streaming }
            : item,
        ),
      };
    case "view":
      return {
        ...state,
        view: event.view,
        seenPendingIds: withSeenPending(state.seenPendingIds, event.view),
      };
    case "ended":
      return { ...state, ended: true };
  }
}

/**
 * The guest's messages to show after the transcript, oldest first. Pending ones always show. A
 * sent or dismissed one shows only if this page saw it waiting and it has no transcript row yet:
 * a queued send, or a dismissal to report. The transcript is a bounded window, so a resolved
 * message the page never saw waiting is old history, not something to place at the end.
 */
export function unplacedGuestMessages(
  messages: ReadonlyArray<ThreadGuestMessage>,
  items: ReadonlyArray<GuestTranscriptItem>,
  seenPendingIds: ReadonlySet<GuestMessageId>,
): ReadonlyArray<ThreadGuestMessage> {
  const placed = new Set(
    items.flatMap((item) =>
      item.kind === "user" && item.guestMessageId ? [item.guestMessageId] : [],
    ),
  );
  return messages
    .filter(
      (message) =>
        !placed.has(message.id) && (message.status === "pending" || seenPendingIds.has(message.id)),
    )
    .toSorted((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** "23h left" or "5m left", rounded down, for the guest page header. */
export function formatGuestExpiry(expiresAt: string, nowMs: number): string {
  const minutes = Math.floor((Date.parse(expiresAt) - nowMs) / 60_000);
  if (minutes <= 0) return "Expired";
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h left` : `${minutes}m left`;
}
