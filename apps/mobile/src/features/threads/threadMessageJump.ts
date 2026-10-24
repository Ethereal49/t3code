import type { MessageId } from "@t3tools/contracts";

// A palette message result opens its thread at that message. The thread
// screen reads the request while it shows that thread, and finishes it once
// the feed is there or the message cannot be found.
let pending: { readonly threadKey: string; readonly messageId: MessageId } | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(threadKey: string, messageId: MessageId): void {
  pending = { threadKey, messageId };
  notify();
}

/** The message this thread should open at, if a palette pick asked for one. */
export function pendingThreadMessageJump(threadKey: string): MessageId | null {
  return pending?.threadKey === threadKey ? pending.messageId : null;
}

export function finishThreadMessageJump(threadKey: string): void {
  if (pending?.threadKey !== threadKey) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
