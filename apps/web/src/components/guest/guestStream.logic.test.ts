import type { GuestShareView, GuestStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGuestStreamEvent,
  initialGuestStreamState,
  parseGuestStreamEvent,
  type GuestStreamState,
} from "./guestStream.logic";

const view: GuestShareView = {
  title: "Fix login",
  guestName: "Sam",
  expiresAt: "2026-10-24T00:00:00.000Z",
  working: true,
  messages: [],
};

const apply = (events: ReadonlyArray<GuestStreamEvent>, state = initialGuestStreamState) =>
  events.reduce<GuestStreamState>(applyGuestStreamEvent, state);

describe("applyGuestStreamEvent", () => {
  it("replaces everything on snapshot, so a reconnect drops stale items", () => {
    const before = apply([
      { type: "snapshot", view, items: [{ kind: "tool", id: "old", label: "Read file" }] },
      { type: "ended" },
    ]);
    const after = apply(
      [
        {
          type: "snapshot",
          view,
          items: [{ kind: "user", id: "u1", text: "hi", streaming: false }],
        },
      ],
      before,
    );
    expect(after).toEqual({
      view,
      items: [{ kind: "user", id: "u1", text: "hi", streaming: false }],
      ended: false,
    });
  });

  it("upserts items by id and keeps their order", () => {
    const state = apply([
      { type: "snapshot", view, items: [] },
      { type: "item", item: { kind: "assistant", id: "a1", text: "Hel", streaming: true } },
      { type: "item", item: { kind: "tool", id: "t1", label: "Ran tests" } },
      { type: "item", item: { kind: "assistant", id: "a1", text: "Hello", streaming: false } },
    ]);
    expect(state.items.map((item) => item.id)).toEqual(["a1", "t1"]);
    expect(state.items[0]).toEqual({
      kind: "assistant",
      id: "a1",
      text: "Hello",
      streaming: false,
    });
  });

  it("appends streamed text to the matching item and ignores unknown ids", () => {
    const state = apply([
      {
        type: "snapshot",
        view,
        items: [{ kind: "assistant", id: "a1", text: "Hel", streaming: true }],
      },
      { type: "append", id: "a1", text: "lo", streaming: true },
      { type: "append", id: "missing", text: "x", streaming: false },
      { type: "append", id: "a1", text: "!", streaming: false },
    ]);
    expect(state.items).toEqual([
      { kind: "assistant", id: "a1", text: "Hello!", streaming: false },
    ]);
  });

  it("marks the stream ended", () => {
    expect(apply([{ type: "snapshot", view, items: [] }, { type: "ended" }]).ended).toBe(true);
  });
});

describe("parseGuestStreamEvent", () => {
  it("decodes a valid frame and rejects malformed ones", () => {
    expect(parseGuestStreamEvent(JSON.stringify({ type: "ended" }))).toEqual({ type: "ended" });
    expect(parseGuestStreamEvent("{not json")).toBeNull();
    expect(parseGuestStreamEvent(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});
