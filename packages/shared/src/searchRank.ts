/**
 * Word-aware fuzzy ranking for the command palettes (web, desktop, mobile) and
 * the MCP thread search, so every surface puts the same thread first.
 *
 * A match scores by quality: a whole word beats a word prefix, which beats a
 * one-typo prefix, which beats a mid-word substring. Word starts include
 * camelCase, kebab, path, and letter/digit boundaries. Thread scores then
 * multiply quality by how recently and often the thread was used.
 */

const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const COMBINING_MARKS = /\p{M}/gu;

interface SearchField {
  /** Case- and accent-folded text. */
  readonly text: string;
  readonly wordStarts: ReadonlyArray<boolean>;
  /** The source string index of each folded character, for highlighting. */
  readonly sourceIndex: ReadonlyArray<number>;
  readonly sourceLength: number;
}

export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

// Thread titles, branches, and project names repeat across keystrokes; folding
// them once keeps a keystroke to plain string scans.
const fieldCache = new Map<string, SearchField>();
const FIELD_CACHE_LIMIT = 10_000;

function foldCharacter(character: string): string {
  return character.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
}

// Chinese and Japanese text has no spaces, so each ideograph or kana starts a word.
function isCjk(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function foldSearchField(source: string): SearchField {
  let text = "";
  const wordStarts: boolean[] = [];
  const sourceIndex: number[] = [];
  let previous = "";
  let index = 0;
  for (const character of source) {
    const startsWord =
      ALPHANUMERIC.test(character) &&
      (previous === "" ||
        !ALPHANUMERIC.test(previous) ||
        (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
        DIGIT.test(previous) !== DIGIT.test(character) ||
        isCjk(character));
    const folded = foldCharacter(character);
    for (let offset = 0; offset < folded.length; offset++) {
      text += folded[offset];
      wordStarts.push(offset === 0 && startsWord);
      sourceIndex.push(index);
    }
    previous = character;
    index += character.length;
  }
  return { text, wordStarts, sourceIndex, sourceLength: source.length };
}

function prepareSearchField(source: string): SearchField {
  const cached = fieldCache.get(source);
  if (cached) return cached;
  const field = foldSearchField(source);
  if (fieldCache.size >= FIELD_CACHE_LIMIT) fieldCache.clear();
  fieldCache.set(source, field);
  return field;
}

/** Folded, whitespace-collapsed query; empty when there is nothing to match. */
export function normalizeSearchQuery(query: string): string {
  return Array.from(query, foldCharacter).join("").replace(/\s+/g, " ").trim();
}

function wordEnd(field: SearchField, index: number): number {
  let end = index + 1;
  while (end < field.text.length && !field.wordStarts[end] && ALPHANUMERIC.test(field.text[end]!)) {
    end++;
  }
  return end;
}

// One substitution, insertion, deletion, or swap of neighbours.
function withinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  const restLeft = left.slice(index);
  const restRight = right.slice(index);
  if (restLeft === restRight) return true;
  if (restLeft.slice(1) === restRight.slice(1)) return true;
  if (restLeft.slice(1) === restRight || restLeft === restRight.slice(1)) return true;
  return (
    restLeft[0] === restRight[1] &&
    restLeft[1] === restRight[0] &&
    restLeft.slice(2) === restRight.slice(2)
  );
}

function isSwap(left: string, right: string): boolean {
  for (let index = 0; index < left.length - 1; index++) {
    if (left[index] === right[index]) continue;
    return (
      left[index] === right[index + 1] &&
      left[index + 1] === right[index] &&
      left.slice(index + 2) === right.slice(index + 2)
    );
  }
  return false;
}

const WHOLE_WORD = 1;
const MID_WORD = 0.3;
const TYPO = 0.45;

interface TokenMatch extends SearchRange {
  readonly score: number;
}

/**
 * Best match of one folded query token in a field. Tokens shorter than four
 * characters only match at a word start ("del" should not find "model"). With
 * `typos`, a three-character token may swap a pair and a longer one may carry
 * one typo in a word prefix that keeps its first letter. Numbers never match
 * with a typo: 22889 is not pull request 22189.
 */
function matchToken(field: SearchField, token: string, typos: boolean): TokenMatch | null {
  let best: TokenMatch | null = null;
  for (
    let index = field.text.indexOf(token);
    index !== -1;
    index = field.text.indexOf(token, index + 1)
  ) {
    if (field.wordStarts[index]) {
      const wordLength = wordEnd(field, index) - index;
      const score =
        token.length >= wordLength ? WHOLE_WORD : 0.7 + (0.2 * token.length) / wordLength;
      if (best === null || score > best.score) {
        best = { score, start: index, end: index + token.length };
      }
      if (score === WHOLE_WORD) return best;
    } else if (token.length >= 4 && best === null) {
      best = { score: MID_WORD, start: index, end: index + token.length };
    }
  }
  if (best !== null || !typos || token.length < 3 || DIGIT.test(token)) return best;
  for (let index = 0; index < field.text.length; index++) {
    if (!field.wordStarts[index]) continue;
    const word = field.text.slice(index, wordEnd(field, index));
    // A three-letter token only forgives a swapped pair: any other edit matches too much.
    const lengths = token.length === 3 ? [3] : [token.length - 1, token.length, token.length + 1];
    // People rarely mistype the first letter, so a typo keeps it, unless it swaps the first two.
    const firstLetterKept = word[0] === token[0] || (word[0] === token[1] && word[1] === token[0]);
    if (!firstLetterKept) continue;
    for (const length of lengths) {
      if (length > word.length) continue;
      const prefix = word.slice(0, length);
      if (token.length === 3 ? isSwap(token, prefix) : withinOneEdit(token, prefix)) {
        return { score: TYPO, start: index, end: index + length };
      }
    }
  }
  return null;
}

interface WeightedSearchField {
  readonly value: string;
  readonly weight: number;
}

interface SearchFieldsMatch {
  /** Roughly 0.3 (weak) to 1.75 (exact title). */
  readonly quality: number;
  /** Source ranges matched in the first field, for highlighting. */
  readonly primaryRanges: ReadonlyArray<SearchRange>;
}

function toSourceRanges(field: SearchField, ranges: ReadonlyArray<SearchRange>): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const start = field.sourceIndex[range.start]!;
    const end =
      range.end < field.sourceIndex.length ? field.sourceIndex[range.end]! : field.sourceLength;
    const last = merged.at(-1);
    if (last && start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, end) };
    } else {
      merged.push({ start, end });
    }
  }
  return merged;
}

/**
 * Every query token must match some field. Quality is the mean of each token's
 * best weighted match, plus a bonus when the first field holds the whole query
 * as a phrase or equals it.
 */
function matchSearchFields(
  normalizedQuery: string,
  fields: ReadonlyArray<WeightedSearchField>,
  options?: { readonly typos?: boolean },
): SearchFieldsMatch | null {
  if (normalizedQuery.length === 0) return null;
  const prepared = fields
    .filter((field) => field.value.length > 0)
    .map((field) => ({ field: prepareSearchField(field.value), weight: field.weight }));
  const primary = fields[0]?.value ? prepared[0]?.field : undefined;
  const tokens = normalizedQuery.split(" ");
  const primaryRanges: SearchRange[] = [];
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    let bestPrimary: TokenMatch | null = null;
    for (const { field, weight } of prepared) {
      if (best >= weight && field !== primary) continue;
      const match = matchToken(field, token, options?.typos ?? false);
      if (match === null) continue;
      if (field === primary) bestPrimary = match;
      if (match.score * weight > best) best = match.score * weight;
    }
    if (best === 0) return null;
    if (bestPrimary) primaryRanges.push(bestPrimary);
    total += best;
  }
  let quality = total / tokens.length;
  if (primary) {
    if (primary.text === normalizedQuery) quality += 0.5;
    else if (tokens.length > 1 && primary.text.includes(normalizedQuery)) quality += 0.25;
  }
  return { quality, primaryRanges: primary ? toSourceRanges(primary, primaryRanges) : [] };
}

// The server's trigram index cannot match shorter tokens, and a two-letter
// substring of a message is noise rather than a match.
const MESSAGE_TOKEN_MIN_LENGTH = 3;

/**
 * Message search tokens: every `long` one must appear as a substring; `short`
 * ones only narrow those hits ("pnpm 12"). No long token means no search.
 */
export function messageSearchTokens(normalizedQuery: string): {
  readonly long: ReadonlyArray<string>;
  readonly short: ReadonlyArray<string>;
} {
  const tokens = normalizedQuery.split(" ").filter((token) => token.length > 0);
  return {
    long: tokens.filter((token) => [...token].length >= MESSAGE_TOKEN_MIN_LENGTH),
    short: tokens.filter((token) => [...token].length < MESSAGE_TOKEN_MIN_LENGTH),
  };
}

/**
 * Ranges of `text` that contain a query token of three or more characters, for
 * message snippets. Message search matches those tokens as plain substrings
 * and ignores shorter ones, which would light up half the snippet. Snippets
 * vary per query, so they skip the field cache.
 */
export function findSearchTokenRanges(text: string, normalizedQuery: string): SearchRange[] {
  if (normalizedQuery.length === 0) return [];
  const field = foldSearchField(text);
  const ranges: SearchRange[] = [];
  for (const token of new Set(messageSearchTokens(normalizedQuery).long)) {
    for (
      let index = field.text.indexOf(token);
      index !== -1;
      index = field.text.indexOf(token, index + token.length)
    ) {
      ranges.push({ start: index, end: index + token.length });
    }
  }
  return toSourceRanges(field, ranges);
}

export interface SearchTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

/** `text` cut into plain and highlighted parts at sorted, non-overlapping `ranges`. */
export function splitSearchText(
  text: string,
  ranges: ReadonlyArray<SearchRange>,
): SearchTextPart[] {
  const parts: SearchTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
    }
    parts.push({ text: text.slice(range.start, range.end), highlighted: true, start: range.start });
    cursor = range.end;
  }
  if (cursor < text.length || parts.length === 0) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Both activity recency and open counts halve every two weeks. */
export const SEARCH_RECENCY_HALF_LIFE_MS = 14 * DAY_MS;
/**
 * Opens closer together than this count once, so flipping between threads is
 * not frequency. Clients skip sending them.
 */
export const THREAD_OPEN_DEDUPE_MS = 10 * 60 * 1000;
const THREAD_SEARCH_PICK_LIMIT = 3;
const THREAD_SEARCH_PICK_MAX_LENGTH = 32;

function decay(ageMs: number): number {
  return 2 ** (-Math.max(0, ageMs) / SEARCH_RECENCY_HALF_LIFE_MS);
}

/** Server-stored open history: a decayed open count and the queries that led to opens. */
export interface ThreadOpenStats {
  readonly openedAt: number;
  readonly score: number;
  readonly queries: ReadonlyArray<string>;
}

/**
 * Next open stats after an open at `at`. `query` is the palette query that
 * picked the thread, when it was opened from search.
 */
export function recordThreadOpen(
  previous: ThreadOpenStats | null,
  at: number,
  query: string | undefined,
): ThreadOpenStats {
  const pick = normalizeSearchQuery(query ?? "")
    .slice(0, THREAD_SEARCH_PICK_MAX_LENGTH)
    .trim();
  const queries = pick
    ? [pick, ...(previous?.queries ?? []).filter((existing) => existing !== pick)].slice(
        0,
        THREAD_SEARCH_PICK_LIMIT,
      )
    : (previous?.queries ?? []);
  if (previous !== null && at - previous.openedAt < THREAD_OPEN_DEDUPE_MS) {
    return { ...previous, queries };
  }
  const score = previous === null ? 1 : previous.score * decay(at - previous.openedAt) + 1;
  return { openedAt: at, score, queries };
}

export interface ThreadSearchSubject {
  /** Matched only by the whole query, like references. */
  readonly id?: string;
  readonly title: string;
  readonly branch?: string | null;
  readonly projectTitle?: string | null;
  readonly pullRequests?: ReadonlyArray<{
    readonly number: number;
    readonly title?: string | null;
    /** Values such as URLs, matched only by the whole query. */
    readonly references?: ReadonlyArray<string>;
  }>;
  /** Latest user activity, in epoch ms. */
  readonly activityAt: number | null;
  readonly opens?: ThreadOpenStats | null;
}

/**
 * How much use lifts a thread: 1 for a stale, never-opened thread, about 2 for
 * one active today, and more for threads opened often.
 */
function threadUsageBoost(thread: ThreadSearchSubject, now: number): number {
  const recency = thread.activityAt === null ? 0 : decay(now - thread.activityAt);
  const opens = thread.opens ? thread.opens.score * decay(now - thread.opens.openedAt) : 0;
  return 1 + recency + 0.5 * Math.log2(1 + opens);
}

const REFERENCE_PREFIX_MIN = 8;

// IDs and URLs split into many word starts, so matching them as fields would
// let a two-letter query hit every thread. Only a pasted value, or a long
// prefix of one, matches. Both are ASCII, so lowercasing is enough.
function matchReference(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
): SearchFieldsMatch | null {
  if (normalizedQuery.length < REFERENCE_PREFIX_MIN) return null;
  const references = [
    ...(thread.id ? [thread.id] : []),
    ...(thread.pullRequests ?? []).flatMap((pullRequest) => pullRequest.references ?? []),
  ];
  return references.some((reference) => reference.toLowerCase().startsWith(normalizedQuery))
    ? { quality: 0.6, primaryRanges: [] }
    : null;
}

// Strong enough that a thread you just picked for this query wins over a better
// but unused match. It fades with the thread's last open, so old picks let go.
const PICK_BOOST = 3;
// A remembered pick alone lists its thread (one picked through a message
// match, say), but a single letter is too little to go on.
const PICK_ONLY_MIN_LENGTH = 2;

function pickBoost(thread: ThreadSearchSubject, normalizedQuery: string, now: number): number {
  const { opens } = thread;
  return opens?.queries.some((pick) => pick.startsWith(normalizedQuery))
    ? PICK_BOOST * decay(now - opens.openedAt)
    : 0;
}

export interface ThreadSearchMatch {
  /** Match quality times use; what results sort by. */
  readonly score: number;
  readonly titleRanges: ReadonlyArray<SearchRange>;
}

/**
 * Scores a thread for a normalized query, or null when it does not match.
 * Titles and pull request numbers count fully, pull request titles and
 * branches less, project names least.
 */
export function scoreThreadSearch(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
  now: number,
  options?: { readonly typos?: boolean },
): ThreadSearchMatch | null {
  const fields: WeightedSearchField[] = [{ value: thread.title, weight: 1 }];
  for (const pullRequest of thread.pullRequests ?? []) {
    fields.push({ value: `#${pullRequest.number}`, weight: 1 });
    if (pullRequest.title) fields.push({ value: pullRequest.title, weight: 0.5 });
  }
  if (thread.branch) fields.push({ value: thread.branch, weight: 0.6 });
  if (thread.projectTitle) fields.push({ value: thread.projectTitle, weight: 0.45 });
  const boost = pickBoost(thread, normalizedQuery, now);
  const match =
    matchSearchFields(normalizedQuery.replace(/^#/, ""), fields, options) ??
    matchReference(normalizedQuery, thread) ??
    (boost > 0 && normalizedQuery.length >= PICK_ONLY_MIN_LENGTH
      ? { quality: 0.5, primaryRanges: [] }
      : null);
  if (match === null) return null;
  return {
    score: match.quality * (threadUsageBoost(thread, now) + boost),
    titleRanges: match.primaryRanges,
  };
}

/**
 * Orders message matches from the server by the same use and pick signals as
 * title matches. `rank` is the match's position in its own environment's
 * results, which stand in for text relevance, so environments merge fairly.
 */
export function rankMessageMatches<T extends { readonly rank: number }>(
  matches: ReadonlyArray<T>,
  subjectOf: (match: T) => ThreadSearchSubject | undefined,
  normalizedQuery: string,
  now: number,
): T[] {
  return matches
    .flatMap((match) => {
      const subject = subjectOf(match);
      if (!subject) return [];
      const use = threadUsageBoost(subject, now) + pickBoost(subject, normalizedQuery, now);
      return [{ match, score: use / (1 + 0.15 * match.rank) }];
    })
    .sort((left, right) => right.score - left.score)
    .map(({ match }) => match);
}

export interface RankedSearchItem<T, M> {
  readonly item: T;
  readonly match: M;
}

/**
 * Ranks grouped items, best score first within each group. Groups with no
 * match are dropped, and the rest order by their best score, so the top row is
 * the best result overall; ties keep the given order. Callers weigh groups
 * through the score: a thread's score includes its use, so an active thread
 * outranks a setting that matches about as well.
 *
 * Typos are only tried when nothing matches exactly in any group: next to a
 * correct match, typo matches are noise ("enter" finding "external"), and
 * skipping them keeps a keystroke cheap.
 */
export function rankSearchGroups<G, T, M extends { readonly score: number }>(
  groups: ReadonlyArray<{ readonly group: G; readonly items: ReadonlyArray<T> }>,
  score: (item: T, options: { readonly typos: boolean }, group: G) => M | null,
): Array<{ readonly group: G; readonly ranked: ReadonlyArray<RankedSearchItem<T, M>> }> {
  const rank = (typos: boolean) =>
    groups.map(({ group, items }) => ({
      group,
      ranked: items.flatMap((item) => {
        const match = score(item, { typos }, group);
        return match === null ? [] : [{ item, match }];
      }),
    }));
  let ranked = rank(false);
  if (ranked.every((entry) => entry.ranked.length === 0)) ranked = rank(true);
  return ranked
    .flatMap(({ group, ranked: items }, order) => {
      if (items.length === 0) return [];
      const sorted = [...items].sort((left, right) => right.match.score - left.match.score);
      return [{ group, ranked: sorted, best: sorted[0]!.match.score, order }];
    })
    .sort((left, right) => right.best - left.best || left.order - right.order)
    .map(({ group, ranked: items }) => ({ group, ranked: items }));
}

/** `rankSearchGroups` for a single list. */
export function rankSearchItems<T, M extends { readonly score: number }>(
  items: ReadonlyArray<T>,
  score: (item: T, options: { readonly typos: boolean }) => M | null,
): ReadonlyArray<RankedSearchItem<T, M>> {
  return rankSearchGroups([{ group: null, items }], score)[0]?.ranked ?? [];
}

export interface SearchTermsMatch {
  readonly score: number;
  readonly ranges: ReadonlyArray<SearchRange>;
}

// Below this, keywords match too much: "co" or "pro" would list most settings.
const KEYWORD_QUERY_MIN_LENGTH = 4;

/**
 * Scores a non-thread result such as a command or project. The first term
 * names it; the others are keywords that help it match but count less, and
 * only for queries of four or more characters. `weight` scales the score
 * against other groups.
 */
export function scoreSearchTerms(
  normalizedQuery: string,
  terms: ReadonlyArray<string>,
  options?: { readonly typos?: boolean; readonly weight?: number },
): SearchTermsMatch | null {
  const fields = normalizedQuery.length < KEYWORD_QUERY_MIN_LENGTH ? terms.slice(0, 1) : terms;
  const match = matchSearchFields(
    normalizedQuery,
    fields.map((value, index) => ({ value, weight: index === 0 ? 1 : 0.6 })),
    options,
  );
  return match && { score: match.quality * (options?.weight ?? 1), ranges: match.primaryRanges };
}
