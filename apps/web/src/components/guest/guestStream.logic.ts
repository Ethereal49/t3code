import {
  GuestStreamEvent,
  type GuestShareView,
  type GuestTranscriptItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface GuestStreamState {
  readonly view: GuestShareView | null;
  readonly items: ReadonlyArray<GuestTranscriptItem>;
  readonly ended: boolean;
}

export const initialGuestStreamState: GuestStreamState = { view: null, items: [], ended: false };

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
      return { view: event.view, items: event.items, ended: false };
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
      return { ...state, view: event.view };
    case "ended":
      return { ...state, ended: true };
  }
}
