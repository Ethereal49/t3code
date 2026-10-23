import type { ThreadFindStart } from "./threadFind";

const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";

export function requestThreadFindOpen(): void {
  window.dispatchEvent(new Event(THREAD_FIND_OPEN_EVENT));
}

export function subscribeThreadFindOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}

const THREAD_FIND_QUERY_EVENT = "t3:thread-find-query";
interface PendingFind {
  readonly query: string;
  /** Where find starts, such as the message a palette result came from. */
  readonly start?: ThreadFindStart;
}
// A find a palette message result asked for, until that thread's view takes it.
let pendingFind: (PendingFind & { readonly threadKey: string }) | null = null;

/** Opens find on `query` in the thread's view, now or once it mounts. */
export function requestThreadFindQuery(threadKey: string, find: PendingFind): void {
  pendingFind = { threadKey, ...find };
  window.dispatchEvent(new Event(THREAD_FIND_QUERY_EVENT));
}

/** The find waiting for this thread's view; answers once. */
export function takeThreadFindQuery(threadKey: string): PendingFind | null {
  if (pendingFind?.threadKey !== threadKey) return null;
  const find = pendingFind;
  pendingFind = null;
  return find;
}

export function subscribeThreadFindQuery(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_QUERY_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_QUERY_EVENT, listener);
}
