import { describe, expect, it } from "vite-plus/test";

import {
  findSearchTokenRanges,
  normalizeSearchQuery,
  rankMessageMatches,
  rankSearchGroups,
  rankSearchItems,
  recordThreadOpen,
  scoreSearchTerms,
  scoreThreadSearch,
  SEARCH_RECENCY_HALF_LIFE_MS,
  type ThreadSearchSubject,
} from "./searchRank.ts";

const NOW = Date.UTC(2026, 9, 23);
const DAY = 24 * 60 * 60 * 1000;

function thread(title: string, overrides: Partial<ThreadSearchSubject> = {}): ThreadSearchSubject {
  return { title, activityAt: NOW - 30 * DAY, ...overrides };
}

function rankTitles(query: string, threads: ReadonlyArray<ThreadSearchSubject>): string[] {
  const normalized = normalizeSearchQuery(query);
  return rankSearchItems(threads, (subject, options) =>
    scoreThreadSearch(normalized, subject, NOW, options),
  ).map(({ item }) => item.title);
}

describe("scoreThreadSearch", () => {
  it("ranks whole words over prefixes over newer mid-word matches", () => {
    expect(
      rankTitles("auth", [
        thread("Fix oauth redirect", { activityAt: NOW }),
        thread("Authentication cleanup"),
        thread("Share auth across worktrees"),
      ]),
    ).toEqual(["Share auth across worktrees", "Authentication cleanup", "Fix oauth redirect"]);
  });

  it("treats camelCase, kebab, path, and digit boundaries as word starts", () => {
    const starts = (title: string, query: string) =>
      scoreThreadSearch(query, thread(title), NOW)?.titleRanges;
    expect(starts("useThreadSearch hook", "search")).toEqual([{ start: 9, end: 15 }]);
    expect(starts("fix/sidebar-perf", "perf")).toEqual([{ start: 12, end: 16 }]);
    expect(starts("Upgrade to pnpm12", "12")).toEqual([{ start: 15, end: 17 }]);
    // Short tokens never match mid-word.
    expect(scoreThreadSearch("ci", thread("Decision log"), NOW)).toBeNull();
  });

  it("lets recent activity and frequent opens decide between equal matches", () => {
    expect(
      rankTitles("goldbug", [
        thread("Goldbug epilogue", { activityAt: NOW - 20 * DAY }),
        thread("Goldbug processes", { activityAt: NOW - DAY }),
      ]),
    ).toEqual(["Goldbug processes", "Goldbug epilogue"]);
    expect(
      rankTitles("goldbug", [
        thread("Goldbug processes", { activityAt: NOW - DAY }),
        thread("Goldbug notes", {
          activityAt: NOW - 40 * DAY,
          opens: { openedAt: NOW - DAY, score: 12, queries: [] },
        }),
      ]),
    ).toEqual(["Goldbug notes", "Goldbug processes"]);
  });

  it("puts the thread picked for a query first when that query is typed again", () => {
    const threads = [
      thread("Release checklist", {
        opens: { openedAt: NOW - 5 * DAY, score: 1, queries: ["rel"] },
      }),
      thread("Relay pairing", { activityAt: NOW }),
    ];
    expect(rankTitles("re", threads)).toEqual(["Release checklist", "Relay pairing"]);
    expect(rankTitles("rel", threads)).toEqual(["Release checklist", "Relay pairing"]);
    // Once the query leaves the pick behind, the better match wins again.
    expect(rankTitles("rela", threads)).toEqual(["Relay pairing"]);
    // An old pick fades with the thread's last open.
    const stale = [
      thread("Release checklist", {
        opens: { openedAt: NOW - 90 * DAY, score: 1, queries: ["rel"] },
      }),
      thread("Relay pairing", { activityAt: NOW }),
    ];
    expect(rankTitles("rel", stale)).toEqual(["Relay pairing", "Release checklist"]);
  });

  it("matches pull request numbers, branches, and projects with every token somewhere", () => {
    const subject = thread("Trim model lists", {
      branch: "t3/trim-mcp-models",
      projectTitle: "t3code",
      pullRequests: [{ number: 22889, title: "Smaller MCP payloads" }],
    });
    for (const query of ["#22889", "22889", "trim mcp", "payloads t3code", "models trim"]) {
      expect(scoreThreadSearch(normalizeSearchQuery(query), subject, NOW), query).not.toBeNull();
    }
    expect(scoreThreadSearch("trim lakebed", subject, NOW)).toBeNull();
  });

  it("forgives one typo only when nothing matches exactly", () => {
    const threads = [thread("Hosting alternatives to Railway"), thread("Trim MCP model lists")];
    expect(rankTitles("railwya", threads)).toEqual(["Hosting alternatives to Railway"]);
    expect(rankTitles("trim mpc", threads)).toEqual(["Trim MCP model lists"]);
    expect(
      rankTitles("drga", [thread("Restore drag handles"), thread("Organize indicators")]),
    ).toEqual(["Restore drag handles"]);
    expect(rankTitles("22889", [thread("Stats", { pullRequests: [{ number: 22189 }] })])).toEqual(
      [],
    );
    // A typo beats a mid-word accident: "ilde" is "idle", not the middle of "Builder".
    expect(
      rankTitles("ilde", [thread("Typesafe App Builder"), thread("De-risk idle tunnel cleanup")]),
    ).toEqual(["De-risk idle tunnel cleanup", "Typesafe App Builder"]);
    // "enter" is not "external" when the right thread is already there.
    expect(
      rankTitles("cmd enter", [thread("Fix Cmd+Enter"), thread("Open links external")]),
    ).toEqual(["Fix Cmd+Enter"]);
  });
});

describe("scoreThreadSearch beyond Latin text and titles", () => {
  it("treats each Chinese or Japanese character as a word start", () => {
    expect(scoreThreadSearch("搜索", thread("实现全文搜索"), NOW)).not.toBeNull();
    expect(scoreThreadSearch("検索", thread("新しい検索機能"), NOW)).not.toBeNull();
  });

  it("lists a thread picked for a query even when only its messages matched", () => {
    const picked = thread("Hosting alternatives", {
      opens: { openedAt: NOW - DAY, score: 1, queries: ["tigris"] },
    });
    expect(rankTitles("tig", [picked, thread("Unrelated")])).toEqual(["Hosting alternatives"]);
    expect(rankTitles("t", [picked])).toEqual([]);
  });
});

describe("rankMessageMatches", () => {
  it("merges environments by each match's own rank and lets use and picks decide", () => {
    const subjects = new Map([
      ...Array.from({ length: 50 }, (_, index) => [`a${index}`, thread(`A ${index}`)] as const),
      ["b0", thread("B recent", { activityAt: NOW })],
      ["b1", thread("B picked", { opens: { openedAt: NOW, score: 1, queries: ["needle"] } })],
    ]);
    const matches = [
      ...Array.from({ length: 50 }, (_, rank) => ({ key: `a${rank}`, rank })),
      { key: "b0", rank: 0 },
      { key: "b1", rank: 1 },
    ];
    expect(
      rankMessageMatches(matches, (match) => subjects.get(match.key), "needle", NOW)
        .slice(0, 3)
        .map((match) => match.key),
    ).toEqual(["b1", "b0", "a0"]);
  });
});

describe("rankSearchGroups", () => {
  it("orders groups by their best match and keeps the given order on ties", () => {
    const groups = rankSearchGroups(
      [
        { group: "actions", items: ["Open settings", "New thread"] },
        { group: "threads", items: ["Settings sync rewrite", "Thread settings"] },
        { group: "projects", items: ["Settings app"] },
      ],
      (item, options) => scoreSearchTerms("settings", [item], options),
    );
    expect(groups.map(({ group, ranked }) => [group, ranked.map(({ item }) => item)])).toEqual([
      ["actions", ["Open settings"]],
      ["threads", ["Settings sync rewrite", "Thread settings"]],
      ["projects", ["Settings app"]],
    ]);
  });
});

describe("recordThreadOpen", () => {
  it("decays the open count, merges quick reopens, and keeps the latest picked queries", () => {
    const first = recordThreadOpen(null, NOW, "  Upl ");
    expect(first).toEqual({ openedAt: NOW, score: 1, queries: ["upl"] });
    const reopened = recordThreadOpen(first, NOW + 60_000, "uploadthing");
    expect(reopened).toEqual({ openedAt: NOW, score: 1, queries: ["uploadthing", "upl"] });
    const later = recordThreadOpen(reopened, NOW + SEARCH_RECENCY_HALF_LIFE_MS, "x".repeat(50));
    expect(later.score).toBe(1.5);
    expect(later.queries).toEqual(["x".repeat(32), "uploadthing", "upl"]);
    expect(recordThreadOpen(later, later.openedAt + DAY, "upl").queries).toEqual([
      "upl",
      "x".repeat(32),
      "uploadthing",
    ]);
  });
});

describe("findSearchTokenRanges", () => {
  it("maps folded matches back to the source text and skips short tokens", () => {
    const text = "Le Café résumé ci";
    expect(findSearchTokenRanges(text, "CAFE resume ci")).toEqual([
      { start: 3, end: 7 },
      { start: 8, end: 14 },
    ]);
  });
});
