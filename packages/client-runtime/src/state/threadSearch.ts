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
  normalizeSearchQuery,
  threadUsageBoost,
  type ThreadSearchSubject,
} from "@t3tools/shared/searchRank";
import { threadSearchPullRequests } from "@t3tools/shared/threadPullRequests";

import type { EnvironmentThreadShell } from "./models.ts";
import { getThreadSortTimestamp } from "./threadSort.ts";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
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
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
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
  "id" | "title" | "branch" | "createdAt" | "updatedAt" | "latestUserMessageAt" | "opens"
> &
  Partial<Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">>;

/** What the web and mobile palettes rank a thread shell by. */
export function threadSearchSubject(
  thread: ThreadSearchShell,
  projectTitle: string | null | undefined,
): ThreadSearchSubject {
  const activityAt = getThreadSortTimestamp(thread, "updated_at");
  return {
    id: thread.id,
    title: thread.title,
    branch: thread.branch,
    projectTitle: projectTitle ?? null,
    pullRequests: threadSearchPullRequests(thread),
    activityAt: Number.isFinite(activityAt) ? activityAt : null,
    opens: thread.opens ? { ...thread.opens, openedAt: Date.parse(thread.opens.openedAt) } : null,
  };
}

/**
 * Orders message matches from the server. The server ranks by text relevance
 * per environment; position stands in for that relevance so it can combine
 * with how recently and often each thread was used, as title matches do.
 */
export function rankThreadMessageMatches<T>(
  matches: ReadonlyArray<T>,
  subjectOf: (match: T) => ThreadSearchSubject | undefined,
  now: number,
): T[] {
  return matches
    .flatMap((match, index) => {
      const subject = subjectOf(match);
      return subject ? [{ match, score: threadUsageBoost(subject, now) / (1 + 0.15 * index) }] : [];
    })
    .sort((left, right) => right.score - left.score)
    .map(({ match }) => match);
}

let pendingSearchPick: { readonly threadKey: string; readonly query: string } | null = null;

/** The palette notes the query that picked a thread just before it navigates there. */
export function rememberThreadSearchPick(threadKey: string, query: string): void {
  pendingSearchPick = { threadKey, query };
}

/** The thread view takes it once, when it records the open of that thread. */
export function takeThreadSearchPick(threadKey: string): string | undefined {
  const pick = pendingSearchPick;
  pendingSearchPick = null;
  return pick?.threadKey === threadKey ? pick.query : undefined;
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
  const current = normalizeSearchQuery(query);
  const before = normalizeSearchQuery(previous?.query ?? "");
  return previous !== null &&
    current.length > 0 &&
    before.length > 0 &&
    (current.startsWith(before) || before.startsWith(current))
    ? previous
    : { query: "", matches: [] };
}
