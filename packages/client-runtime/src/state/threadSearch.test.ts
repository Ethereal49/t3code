import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  claimThreadOpen,
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  threadSearchMatchKey,
  visibleThreadSearch,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("creates keys without array methods unavailable in Hermes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");

  try {
    expect(makeThreadSearchKey([envB, envA], "needle")).toBe('[["env-a","env-b"],"needle"]');
  } finally {
    if (descriptor !== undefined) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
});

it("encodes scoped thread keys without delimiter collisions", () => {
  const first = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env\u0000thread"),
    threadId: ThreadId.make("id"),
  });
  const second = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread\u0000id"),
  });

  expect(first).not.toBe(second);
});

it("ignores invalid search keys", () => {
  let searchCount = 0;
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: () => {
      searchCount += 1;
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  try {
    const state = registry.get(searchAtom(makeThreadSearchKey([envA], "a".repeat(201))));
    const malformedState = registry.get(searchAtom("not json{{"));

    expect(state).toEqual({ matches: [], isLoading: false });
    expect(malformedState).toEqual({ matches: [], isLoading: false });
    expect(searchCount).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("merges successful environments and silently ignores failures", () => {
  const result: OrchestrationSearchThreadsResult = {
    matches: [
      {
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user",
        snippet: "needle",
        messageCreatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (environmentId) =>
      environmentId === envA
        ? Atom.make(AsyncResult.success(result))
        : Atom.make(
            AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
              Cause.fail(new Error("unsupported rpc")),
            ),
          ),
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  const state = registry.get(searchAtom(makeThreadSearchKey([envB, envA], "needle")));
  expect(state).toEqual({
    matches: [{ ...result.matches[0], environmentId: envA, rank: 0 }],
    isLoading: false,
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});

it("keeps the previous results visible only while a refined or widened query is pending", () => {
  const previous = {
    query: "websock",
    matches: [
      {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user" as const,
        snippet: "websocket reconnect",
        messageCreatedAt: null,
        rank: 0,
      },
    ],
  };
  expect(visibleThreadSearch("websocke", null, previous)).toBe(previous);
  expect(visibleThreadSearch("webso", null, previous)).toBe(previous);
  expect(visibleThreadSearch("billing", null, previous)).toEqual({ query: "", matches: [] });
  const ready = { query: "websocke", matches: [] };
  expect(visibleThreadSearch("websocke", ready, previous)).toBe(ready);
});

it("sends one open per thread every ten minutes by this client's clock", () => {
  const minute = 60_000;
  expect(claimThreadOpen(envA, "thread-open", 0)).toBe(true);
  expect(claimThreadOpen(envA, "thread-open", 9 * minute)).toBe(false);
  expect(claimThreadOpen(envB, "thread-open", 9 * minute)).toBe(true);
  expect(claimThreadOpen(envA, "thread-open", 10 * minute)).toBe(true);
});
