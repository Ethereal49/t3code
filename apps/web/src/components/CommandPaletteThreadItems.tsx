import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { normalizeSearchQuery, rankMessageMatches } from "@t3tools/shared/searchRank";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadShells } from "../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useThreadSearch } from "../state/queries";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { buildThreadActionItems, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { useEnvironmentLookups, useProjectLookups } from "./CommandPaletteLookups";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";

function useProviderEntryByEnvironmentAndInstanceId() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const serverConfig = environment.serverConfig;
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
}

function useConnectedThreadSearch(query: string) {
  const { environments } = useEnvironments();
  const environmentIds: ReadonlyArray<EnvironmentId> = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  return useThreadSearch(environmentIds, query);
}

/**
 * Every visible thread as a palette item, plus, for a non-empty
 * `threadSearchQuery`, the threads whose messages match, best first.
 */
export function useCommandPaletteThreadItems(input: {
  readonly activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null;
  readonly threadSearchQuery: string;
}) {
  const { activeThread, threadSearchQuery } = input;
  const navigate = useNavigate();
  const threads = useThreadShells();
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const providerEntryByEnvironmentAndInstanceId = useProviderEntryByEnvironmentAndInstanceId();
  const messageSearch = useConnectedThreadSearch(threadSearchQuery);
  const { projectByKey } = useProjectLookups();
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // Ranking is relative to when the palette opened, so rows do not reorder as time passes.
  const [now] = useState(() => Date.now());

  const threadItems = buildThreadActionItems({
    threads,
    ...(activeThread ? { activeThread } : {}),
    projectByKey,
    sortOrder: sidebarThreadSortOrder,
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
    renderTrailingContent: (thread) => (
      <>
        <ThreadSearchPullRequestNumber
          thread={thread}
          query={threadSearchQuery}
          settled={thread.settledOverride === "settled"}
        />
        <ThreadRowTrailingStatus thread={thread} />
      </>
    ),
    renderDescription: (thread, { projectTitle }) => {
      const modelInstanceId =
        thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      const providerEntry =
        providerEntryByEnvironmentAndInstanceId.get(`${thread.environmentId}:${modelInstanceId}`) ??
        null;
      return (
        <ThreadCommandSubtitle
          project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
          projectTitle={projectTitle ?? null}
          environmentLabel={
            projectEnvironmentLocationById.get(thread.environmentId)?.label ?? "Remote"
          }
          branch={thread.branch}
          worktreePath={thread.worktreePath}
          isCurrent={
            thread.id === activeThread?.id && thread.environmentId === activeThread.environmentId
          }
          driverKind={providerEntry?.driverKind ?? null}
          providerDisplayName={
            thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
          }
          acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
        />
      );
    },
    runThread: async (thread) => {
      // The pick is an open with its query. The thread view also records the
      // open; the server merges the two.
      if (
        threadSearchQuery.trim().length > 0 &&
        !threadSearchQuery.startsWith(">") &&
        thread.lastVisitedAt !== undefined
      ) {
        void visitThread({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            visitedAt: thread.updatedAt,
            opened: true,
            searchQuery: threadSearchQuery,
          },
        });
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
  });

  const itemByValue = new Map(threadItems.map((item) => [item.value, item]));
  const itemForMatch = (match: EnvironmentThreadSearchMatch) =>
    itemByValue.get(`thread:${match.environmentId}:${match.threadId}`);
  const threadMessageItems = rankMessageMatches(
    messageSearch.matches,
    (match) => itemForMatch(match)?.threadSearch,
    normalizeSearchQuery(threadSearchQuery),
    now,
  ).flatMap((match) => {
    const item = itemForMatch(match);
    if (!item) return [];
    // The snippet replaces the project line, so a message row is as tall as a title row.
    const { description: _description, ...rest } = item;
    return [
      {
        ...rest,
        threadContentMatch: {
          source: match.source,
          snippet: match.snippet,
          query: messageSearch.query,
        },
      },
    ];
  });

  return { threadItems, threadMessageItems, now, isSearchPending: messageSearch.isPending };
}
