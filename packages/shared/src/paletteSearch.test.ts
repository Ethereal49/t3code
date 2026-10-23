import { describe, expect, it } from "vite-plus/test";

import {
  findSearchTokenRanges,
  foldSearchQuery,
  pickedQuery,
  rankMessageMatches,
  rankSearchGroups,
  rankSearchItems,
  recordThreadOpen,
  scoreMessageMatch,
  scoreSearchTerms,
  scoreThreadSearch,
  SEARCH_RECENCY_HALF_LIFE_MS,
  type SearchTermsMatch,
  type ThreadSearchSubject,
} from "./paletteSearch.ts";

const NOW = Date.UTC(2026, 9, 23);
const DAY = 24 * 60 * 60 * 1000;

function thread(title: string, overrides: Partial<ThreadSearchSubject> = {}): ThreadSearchSubject {
  return { title, activityAt: NOW - 30 * DAY, ...overrides };
}

function rankTitles(query: string, threads: ReadonlyArray<ThreadSearchSubject>): string[] {
  const normalized = foldSearchQuery(query);
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
    // Opening an old pick some other way does not revive it over a newer pick.
    const reopened = [
      thread("Release checklist", {
        opens: { openedAt: NOW - DAY, pickedAt: NOW - 30 * DAY, score: 2, queries: ["rel"] },
      }),
      thread("Relay pairing", {
        opens: { openedAt: NOW - DAY, pickedAt: NOW - DAY, score: 1, queries: ["rel"] },
      }),
    ];
    expect(rankTitles("rel", reopened)).toEqual(["Relay pairing", "Release checklist"]);
  });

  it("matches pull request numbers, branches, and projects with every token somewhere", () => {
    const subject = thread("Trim model lists", {
      branch: "t3/trim-mcp-models",
      projectTitle: "t3code",
      pullRequests: [{ number: 22889, title: "Smaller MCP payloads" }],
    });
    for (const query of ["#22889", "22889", "trim mcp", "payloads t3code", "models trim"]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW), query).not.toBeNull();
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
  it("says which field matched when the title does not, and reads pull request phrasing", () => {
    const subject = thread("Trim model lists", {
      branch: "t3/cleanup-payloads",
      pullRequests: [{ number: 22889, title: "Smaller MCP payloads" }],
    });
    for (const query of ["pr 22889", "pr22889", "pull 22889", "pull request #22889"]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW)?.hint, query).toEqual({
        label: "PR",
        text: "#22889 Smaller MCP payloads",
        ranges: [{ start: 1, end: 6 }],
      });
    }
    expect(scoreThreadSearch("cleanup", subject, NOW)?.hint).toEqual({
      label: "Branch",
      text: "t3/cleanup-payloads",
      ranges: [{ start: 3, end: 10 }],
    });
    expect(scoreThreadSearch("trim", subject, NOW)?.hint).toBeUndefined();
    // Split across fields, the hint shows the first field with some of the words.
    expect(scoreThreadSearch("cleanup smaller", subject, NOW)?.hint).toEqual({
      label: "PR",
      text: "#22889 Smaller MCP payloads",
      ranges: [{ start: 7, end: 14 }],
    });
    // A long hint starts near the match, so one line shows it.
    const long = thread("Wave 1F", {
      pullRequests: [{ number: 15033, title: "perf: cheaper shell refreshes, fewer MCP payloads" }],
    });
    expect(scoreThreadSearch("mcp", long, NOW)?.hint).toEqual({
      label: "PR",
      text: "…fewer MCP payloads",
      ranges: [{ start: 7, end: 10 }],
    });
    // The words only drop out next to a linked number.
    expect(scoreThreadSearch("pr 12345", subject, NOW)).toBeNull();
  });

  it("reads letters and numbers typed together, without forgiving typos in numbers", () => {
    const threads = [
      thread("Upgrade to pnpm 12"),
      thread("GPT-5 eval"),
      thread("iOS 26 support"),
      thread("Other"),
    ];
    expect(rankTitles("pnpm12", threads)).toEqual(["Upgrade to pnpm 12"]);
    expect(rankTitles("gpt5", threads)).toEqual(["GPT-5 eval"]);
    expect(rankTitles("ios26", threads)).toEqual(["iOS 26 support"]);
    expect(rankTitles("pnpm13", threads)).toEqual([]);
  });

  it("stores picked queries without splitting an emoji", () => {
    expect(pickedQuery(`${"a".repeat(31)}🚀`)).toBe("a".repeat(31));
    expect(pickedQuery("  Upl ")).toBe("Upl");
  });

  it("matches emoji in titles", () => {
    expect(rankTitles("🚀", [thread("🚀 Launch checklist"), thread("Launch notes")])).toEqual([
      "🚀 Launch checklist",
    ]);
  });

  it("treats each Chinese or Japanese character as a word start", () => {
    expect(scoreThreadSearch("搜索", thread("实现全文搜索"), NOW)).not.toBeNull();
    expect(scoreThreadSearch("検索", thread("新しい検索機能"), NOW)).not.toBeNull();
  });

  it("lists a thread picked for a query even when only its messages matched", () => {
    const picked = thread("Hosting alternatives", {
      opens: { openedAt: NOW - DAY, score: 1, queries: ["tigris"] },
    });
    expect(rankTitles("tig", [picked, thread("Unrelated")])).toEqual(["Hosting alternatives"]);
    expect(rankTitles("ti", [picked])).toEqual([]);
  });
});

describe("scoreThreadSearch with heavy use and loose input", () => {
  it("keeps a whole word on a quiet thread above a mid-word hit on a thread opened daily", () => {
    let opens = recordThreadOpen(null, NOW - 60 * DAY, undefined);
    for (let day = 59; day >= 1; day--) opens = recordThreadOpen(opens, NOW - day * DAY, undefined);
    expect(
      rankTitles("auth", [
        thread("Fix oauth redirect", { activityAt: NOW, opens }),
        thread("Share auth across worktrees", { activityAt: NOW - 90 * DAY }),
      ]),
    ).toEqual(["Share auth across worktrees", "Fix oauth redirect"]);
  });

  it("matches initials and word-start runs as a last resort, highlighting each letter", () => {
    const threads = [thread("Fix sidebar lag"), thread("Unrelated work")];
    expect(rankTitles("fsl", threads)).toEqual(["Fix sidebar lag"]);
    expect(rankTitles("fixsid", threads)).toEqual(["Fix sidebar lag"]);
    // A later "F" can start the run.
    expect(rankTitles("fixsid", [thread("Feature: Fix sidebar lag")])).toEqual([
      "Feature: Fix sidebar lag",
    ]);
    expect(scoreThreadSearch("fsl", threads[0]!, NOW, { typos: true })?.titleRanges).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
      { start: 12, end: 13 },
    ]);
  });

  it("finds nothing rather than an unrelated thread when no word matches", () => {
    const threads = [
      thread("Projectless threads without Git"),
      thread("Concern about connection setup"),
      thread("Simplify worktree thread creation"),
      thread("Start a new conversation"),
      thread("Setting up the sentinel"),
      thread("I plan to open source all of lakebed in the next few weeks"),
      thread("Design notes"),
      thread("Link pull request to thread"),
    ];
    for (const query of ["posthog", "cron", "stripe", "gpu", "fxsb", "lint", "deno"]) {
      expect(rankTitles(query, threads), query).toEqual([]);
    }
  });

  it("matches pieces of references that hold a number, and environment names", () => {
    const subject = thread("Trim model lists", {
      id: "thread-5fe6f59c-4976",
      environmentLabel: "BeeBox",
      pullRequests: [
        {
          number: 22889,
          references: ["pingdotgg/t3code#22889", "https://github.com/pingdotgg/t3code/pull/22889"],
        },
      ],
    });
    for (const query of [
      "t3code#22889",
      "github.com/pingdotgg/t3code/pull/22889",
      "5fe6f59c",
      "beebox",
    ]) {
      expect(scoreThreadSearch(foldSearchQuery(query), subject, NOW), query).not.toBeNull();
    }
    expect(scoreThreadSearch("github.com", subject, NOW)).toBeNull();
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

  it("keeps matches inside words below word matches, however used", () => {
    const busy = thread("Busy", {
      activityAt: NOW,
      opens: { openedAt: NOW, score: 20, queries: [] },
    });
    const quiet = thread("Quiet");
    const matches = [
      { key: "busy", rank: 0, midWord: true },
      { key: "quiet", rank: 1 },
    ];
    const subjects = new Map([
      ["busy", busy],
      ["quiet", quiet],
    ]);
    expect(
      rankMessageMatches(matches, (match) => subjects.get(match.key), "rust", NOW).map(
        (match) => match.key,
      ),
    ).toEqual(["quiet", "busy"]);
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

describe("rankSearchGroups with keywords and picks", () => {
  it("forgives typos in names but not in hidden keywords", () => {
    const groups = rankSearchGroups(
      [
        { group: "actions", items: [["Open settings", "preferences", "keybindings"]] },
        { group: "settings", items: [["Keybindings", "General"]] },
      ],
      (terms, options) => scoreSearchTerms("keybindngs", terms, options),
    );
    expect(groups.map(({ group }) => group)).toEqual(["settings"]);
    expect(scoreSearchTerms("duckdb", ["Search engine", "duckduckgo"], { typos: true })).toBeNull();
    expect(scoreSearchTerms("rust", ["GitHub sharing", "trusted"])).toBeNull();
  });

  it("lists a thread named for the query above a command with it as a keyword, and picks first", () => {
    const rank = (command: string[], subject: ThreadSearchSubject) =>
      rankSearchGroups<string, string[] | ThreadSearchSubject, SearchTermsMatch>(
        [
          { group: "actions", items: [command] },
          { group: "threads", items: [subject] },
        ],
        (item, options) => {
          if (Array.isArray(item)) return scoreSearchTerms("mcp", item, options);
          const match = scoreThreadSearch("mcp", item, NOW, options);
          return match && { ...match, ranges: match.titleRanges };
        },
      ).map(({ group }) => group);
    const named = thread("Trim MCP model lists");
    const picked = thread("Trim MCP model lists", {
      opens: { openedAt: NOW, pickedAt: NOW, score: 1, queries: ["mcp"] },
    });
    expect(rank(["Restart agent session", "reload", "mcp"], named)).toEqual(["threads", "actions"]);
    // A command named for the query stays first, unless the thread was picked for it.
    expect(rank(["Reload MCP servers"], named)).toEqual(["actions", "threads"]);
    expect(rank(["Reload MCP servers"], picked)).toEqual(["threads", "actions"]);
  });
});

describe("recordThreadOpen", () => {
  it("decays the open count, merges quick reopens, and keeps the latest picked queries", () => {
    const first = recordThreadOpen(null, NOW, "  Upl ");
    expect(first).toEqual({ openedAt: NOW, pickedAt: NOW, score: 1, queries: ["upl"] });
    const reopened = recordThreadOpen(first, NOW + 60_000, "uploadthing");
    expect(reopened).toEqual({
      openedAt: NOW,
      pickedAt: NOW + 60_000,
      score: 1,
      queries: ["uploadthing", "upl"],
    });
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

  it("highlights a three-letter token only where it starts a word", () => {
    expect(findSearchTokenRanges("drafts, enableFTS", "fts")).toEqual([{ start: 14, end: 17 }]);
  });
});

describe("scoreMessageMatch", () => {
  it("needs short words at a word start and ranks other words found inside words lower", () => {
    const text = `Saved the drafts. ${"More notes. ".repeat(40)}Then enableFTS and Enable FTS.`;
    const fts = scoreMessageMatch(text, "fts");
    expect(fts?.quality).toBe(1);
    expect(text.slice(fts?.offset)).toMatch(/^FTS and/);
    expect(scoreMessageMatch("saved two drafts", "fts")).toBeNull();
    expect(scoreMessageMatch("We trust the build", "rust")).toEqual({ quality: 0.3, offset: 4 });
    expect(scoreMessageMatch("Rust and trust", "rust")).toEqual({ quality: 1, offset: 0 });
    expect(scoreMessageMatch("v12rc build", "rc")?.quality).toBe(1);
  });

  it("finds words through case and accents, also after the same letters inside a word", () => {
    expect(scoreMessageMatch("This addresses Résumé indexing", "res")).toEqual({
      quality: 1,
      offset: 15,
    });
    expect(scoreMessageMatch("Le CAFÉ ouvert", "cafe")).toEqual({ quality: 1, offset: 3 });
    expect(scoreMessageMatch("明天部署到生产环境", "部署")).toEqual({ quality: 1, offset: 2 });
  });
});
