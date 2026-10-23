const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";

export function requestThreadFindOpen(): void {
  window.dispatchEvent(new Event(THREAD_FIND_OPEN_EVENT));
}

export function subscribeThreadFindOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}

const THREAD_FIND_QUERY_EVENT = "t3:thread-find-query";
// A find a palette message result asked for, until that thread's view takes it.
let pendingFindQuery: { readonly threadKey: string; readonly query: string } | null = null;

/** Opens find on `query` in the thread's view, now or once it mounts. */
export function requestThreadFindQuery(threadKey: string, query: string): void {
  pendingFindQuery = { threadKey, query };
  window.dispatchEvent(new Event(THREAD_FIND_QUERY_EVENT));
}

/** The find query waiting for this thread's view; answers once. */
export function takeThreadFindQuery(threadKey: string): string | null {
  if (pendingFindQuery?.threadKey !== threadKey) return null;
  const { query } = pendingFindQuery;
  pendingFindQuery = null;
  return query;
}

export function subscribeThreadFindQuery(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_QUERY_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_QUERY_EVENT, listener);
}
