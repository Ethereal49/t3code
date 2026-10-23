import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  normalizeSearchQuery,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type ThreadSearchSubject,
} from "@t3tools/shared/searchRank";

export interface CommandPaletteItem {
  readonly key: string;
  readonly kind: "action" | "project" | "thread";
  readonly project?: EnvironmentProject;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: ReadonlyArray<string>;
  /** Thread rows rank by match quality and use instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  readonly run: () => void;
}

export interface CommandPaletteResult extends CommandPaletteItem {
  /** Listed because its messages match; the row shows the message snippet. */
  readonly fromMessages?: boolean;
}

const THREAD_RESULT_LIMIT = 20;
const MESSAGE_RESULT_LIMIT = 10;

/**
 * Ranks like the web palette: actions, projects, and threads order by their
 * best match, threads by match quality and use. Threads whose messages match
 * come last, in `messageMatchKeys` order, so late server results never move
 * the rows above them.
 */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  messageMatchKeys: ReadonlyArray<string>,
  now = Date.now(),
): CommandPaletteResult[] {
  const actionsOnly = query.startsWith(">");
  const normalizedQuery = normalizeSearchQuery(actionsOnly ? query.slice(1) : query);
  const candidates = actionsOnly ? items.filter((item) => item.kind === "action") : items;
  if (!normalizedQuery) return candidates.filter((item) => item.kind !== "project");

  // On equal best matches, groups keep this order: threads are what people search for most.
  const kinds = ["action", "thread", "project"] as const;
  const ranked = rankSearchGroups(
    kinds.map((kind) => ({ group: kind, items: candidates.filter((item) => item.kind === kind) })),
    (item, options) =>
      item.threadSearch
        ? scoreThreadSearch(normalizedQuery, item.threadSearch, now, options)
        : scoreSearchTerms(normalizedQuery, [item.title, ...item.searchTerms], options),
  ).flatMap(({ group, ranked: entries }) =>
    (group === "thread" ? entries.slice(0, THREAD_RESULT_LIMIT) : entries).map(
      (entry) => entry.item,
    ),
  );
  if (actionsOnly) return ranked;

  const listed = new Set(ranked.map((item) => item.key));
  const threadByKey = new Map(
    items.filter((item) => item.kind === "thread").map((item) => [item.key, item]),
  );
  const fromMessages = messageMatchKeys
    .flatMap((key) => {
      const item = threadByKey.get(key);
      return item && !listed.has(key) ? [{ ...item, fromMessages: true }] : [];
    })
    .slice(0, MESSAGE_RESULT_LIMIT);
  return [...ranked, ...fromMessages];
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}
