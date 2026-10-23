import {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  foldSearchQuery,
  THREAD_OPEN_DEDUPE_MS,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";
import { threadSearchPullRequests } from "@t3tools/shared/threadPullRequests";

import type { EnvironmentThreadShell } from "./models.ts";
import { getThreadSortTimestamp } from "./threadSort.ts";

// When this client last sent an open per thread, by its own clock: a server
// timestamp would be off by any clock skew. The server merges opens closer
// together than THREAD_OPEN_DEDUPE_MS anyway, so skipping them saves a command
// and a broadcast while flipping between threads.
const sentThreadOpens = new Map<string, number>();
// When this client last opened each thread, sent or not, so recent threads
// follow quick switches the server merges.
const localThreadOpens = new Map<string, number>();
// Palette picks waiting for the thread view they open, which sends the open
// with the picked query: one owner for every open. A pick no view takes (the
// navigation failed) lets go after a while.
const PICK_HANDOFF_MS = 30_000;
const pendingPicks = new Map<string, { readonly query: string; readonly at: number }>();

/**
 * Records that this client opened a thread, and says whether to send the open
 * to the server now.
 */
export function claimThreadOpen(environmentId: EnvironmentId, threadId: string, now: number) {
  const key = `${environmentId}:${threadId}`;
  localThreadOpens.set(key, now);
  if (now - (sentThreadOpens.get(key) ?? Number.NEGATIVE_INFINITY) < THREAD_OPEN_DEDUPE_MS) {
    return false;
  }
  sentThreadOpens.set(key, now);
  return true;
}

/**
 * Hands a palette pick's query to the thread view it opens. Picking the thread
 * that is already open mounts no view, so the palette sends that open itself.
 */
export function handOffPick(
  environmentId: EnvironmentId,
  threadId: string,
  query: string,
  now: number,
) {
  pendingPicks.set(`${environmentId}:${threadId}`, { query, at: now });
}

/**
 * The thread view's open: whether to send it, and the query a palette pick
 * handed over. A pick is always sent, so the server records it even inside
 * an open it merges.
 */
export function takeThreadOpen(
  environmentId: EnvironmentId,
  threadId: string,
  now: number,
): { readonly send: boolean; readonly searchQuery?: string } {
  const key = `${environmentId}:${threadId}`;
  const pick = pendingPicks.get(key);
  pendingPicks.delete(key);
  const searchQuery = pick && now - pick.at < PICK_HANDOFF_MS ? pick.query : undefined;
  const claimed = claimThreadOpen(environmentId, threadId, now);
  return searchQuery === undefined ? { send: claimed } : { send: true, searchQuery };
}

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
  /** Position in its environment's results, which the server orders by match and age. */
  readonly rank: number;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false };
      }

      const [environmentIds, query] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(
            ...value.matches.map((match, rank) => ({
              ...match,
              environmentId,
              rank,
            })),
          );
        }
      }

      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}

export type ThreadSearchShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "branch"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
  | "opens"
> &
  Partial<Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">>;

/**
 * What the web and mobile palettes rank a thread shell by. Pass the
 * environment label only when there are two or more environments.
 */
export function threadSearchSubject(
  thread: ThreadSearchShell,
  projectTitle: string | null | undefined,
  environmentLabel?: string | null,
): ThreadSearchSubject {
  // What the user wrote, not agent wakes or task notices in the user role. A
  // thread the user never wrote in counts from its creation; an older server
  // omits the field, so the latest user-role message stands in.
  const authored = thread.latestUserAuthoredMessageAt;
  const activityAt =
    authored === undefined
      ? getThreadSortTimestamp(thread, "updated_at")
      : Date.parse(authored ?? thread.createdAt);
  const localOpenedAt = localThreadOpens.get(`${thread.environmentId}:${thread.id}`) ?? 0;
  return {
    id: thread.id,
    title: thread.title,
    branch: thread.branch,
    projectTitle: projectTitle ?? null,
    environmentLabel: environmentLabel ?? null,
    pullRequests: threadSearchPullRequests(thread),
    activityAt: Number.isFinite(activityAt) ? activityAt : null,
    // This client's own latest open counts too: the server merged it, or has
    // no record yet (an older server ignores opens).
    opens:
      localOpenedAt > (thread.opens?.openedAt ?? 0)
        ? { score: 1, picks: [], ...thread.opens, openedAt: localOpenedAt }
        : (thread.opens ?? null),
  };
}

/** Message result keys in the order a search box last showed them for `query`. */
export interface ShownOrder {
  readonly query: string;
  readonly keys: ReadonlyArray<string>;
}

/**
 * The order to show message results in: rows already shown for this query
 * keep their places and new ones go below them, so a slower environment's
 * answer never moves a row under the pointer or the keyboard highlight.
 * Returns `previous` when nothing changed, so it can sit in React state.
 */
export function nextShownOrder(
  previous: ShownOrder | null,
  query: string,
  ranked: ReadonlyArray<string>,
): ShownOrder {
  if (previous?.query !== query) return { query, keys: ranked };
  const listed = new Set(ranked);
  const kept = previous.keys.filter((key) => listed.has(key));
  const shown = new Set(kept);
  const keys = [...kept, ...ranked.filter((key) => !shown.has(key))];
  const unchanged =
    keys.length === previous.keys.length &&
    keys.every((key, index) => key === previous.keys[index]);
  return unchanged ? previous : { query, keys };
}

export interface SettledThreadSearch {
  readonly query: string;
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
}

/**
 * What a search box shows for `query`: its own results once they arrive
 * (`ready`), else the previous results if `query` refines or widens their
 * query, so result rows do not blink out and back on every keystroke.
 * Results for an unrelated query clear.
 */
export function visibleThreadSearch(
  query: string,
  ready: SettledThreadSearch | null,
  previous: SettledThreadSearch | null,
): SettledThreadSearch {
  if (ready !== null) return ready;
  const current = foldSearchQuery(query);
  const before = foldSearchQuery(previous?.query ?? "");
  return previous !== null &&
    current.length > 0 &&
    before.length > 0 &&
    (current.startsWith(before) || before.startsWith(current))
    ? previous
    : { query: "", matches: [] };
}
