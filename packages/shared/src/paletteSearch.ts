/**
 * Word-aware fuzzy ranking for the command palettes (web, desktop, mobile) and
 * the MCP thread search, so every surface puts the same thread first.
 *
 * A match scores by quality: a whole word beats a word prefix, which beats a
 * one-typo prefix, which beats a mid-word substring, which beats initials. Word starts include camelCase, kebab, path, and
 * letter/digit boundaries. Thread scores then multiply quality by how recently
 * and often the thread was used, within limits.
 */

import type { OrchestrationV2ThreadOpens } from "@t3tools/contracts";

const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const COMBINING_MARKS = /\p{M}/gu;
// Emoji and other symbols can be searched for, so they start words too.
const SYMBOL = /\p{So}/u;
const APOSTROPHE = /['’]/;

interface SearchField {
  /** Case- and accent-folded text. */
  readonly text: string;
  /** 1 where a word starts in `text`. */
  readonly wordStarts: Uint8Array;
  /**
   * The source string index of each folded character, for highlighting; null
   * when every character maps to itself, as in plain ASCII.
   */
  readonly sourceIndex: Int32Array | null;
  readonly sourceLength: number;
}

export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

// Thread titles, branches, and project names repeat across keystrokes; folding
// them once keeps a keystroke to plain string scans. Each keystroke reads every
// field, so the limit must hold all of them or the cache clears every time; a
// field is a few bytes per character.
const fieldCache = new Map<string, SearchField>();
const FIELD_CACHE_LIMIT = 100_000;

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

// Two Chinese, Japanese, or Korean characters already make a common word.
function hasCjkWord(token: string): boolean {
  return Array.from(token).some((character) => {
    const code = character.codePointAt(0)!;
    return isCjk(character) || (code >= 0xac00 && code <= 0xd7af);
  });
}

function foldSearchField(source: string): SearchField {
  let text = "";
  const wordStarts: number[] = [];
  const sourceIndex: number[] = [];
  let identity = true;
  let previous = "";
  let beforePrevious = "";
  let index = 0;
  for (const character of source) {
    // "Julius’s": a possessive or contraction does not start a word.
    const afterApostrophe = APOSTROPHE.test(previous) && ALPHANUMERIC.test(beforePrevious);
    const startsWord =
      (ALPHANUMERIC.test(character) || SYMBOL.test(character)) &&
      !afterApostrophe &&
      (previous === "" ||
        !ALPHANUMERIC.test(previous) ||
        (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
        DIGIT.test(previous) !== DIGIT.test(character) ||
        isCjk(character));
    const folded = foldCharacter(character);
    identity &&= folded.length === 1 && character.length === 1;
    for (let offset = 0; offset < folded.length; offset++) {
      text += folded[offset];
      wordStarts.push(offset === 0 && startsWord ? 1 : 0);
      sourceIndex.push(index);
    }
    beforePrevious = previous;
    previous = character;
    index += character.length;
  }
  return {
    text,
    wordStarts: Uint8Array.from(wordStarts),
    sourceIndex: identity ? null : Int32Array.from(sourceIndex),
    sourceLength: source.length,
  };
}

function prepareSearchField(source: string): SearchField {
  const cached = fieldCache.get(source);
  // Re-inserting keeps recently read fields at the back, so eviction drops the oldest.
  fieldCache.delete(source);
  const field = cached ?? foldSearchField(source);
  if (fieldCache.size >= FIELD_CACHE_LIMIT) {
    fieldCache.delete(fieldCache.keys().next().value!);
  }
  fieldCache.set(source, field);
  return field;
}

/** Folded, whitespace-collapsed query; empty when there is nothing to match. */
export function foldSearchQuery(query: string): string {
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
const INITIALS = 0.2;

interface TokenMatch extends SearchRange {
  readonly score: number;
  /** Separate ranges, for letters spread out across the field. */
  readonly letters?: ReadonlyArray<SearchRange>;
}

/**
 * Best match of one folded query token in a field. Tokens shorter than four
 * characters only match at a word start ("del" should not find "model"). With
 * `typos`, a three-character token may swap a pair and a longer one may carry
 * one typo in a word prefix that keeps its first letter. Numbers never match
 * with a typo: 22889 is not pull request 22189. With `initials`, the token may
 * also be initials or word-start runs (see `matchInitials`).
 */
function matchToken(
  field: SearchField,
  token: string,
  typos: boolean,
  initials: boolean,
): TokenMatch | null {
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
  if ((best !== null && best.score > MID_WORD) || !typos || token.length < 3 || DIGIT.test(token)) {
    return best;
  }
  for (let index = 0; index < field.text.length; index++) {
    if (!field.wordStarts[index]) continue;
    const word = field.text.slice(index, wordEnd(field, index));
    // Short tokens only forgive a swapped pair: any other edit of a three- or
    // four-letter word matches too much ("cron" would find every "con…").
    const swapOnly = token.length <= 4;
    const lengths = swapOnly ? [token.length] : [token.length - 1, token.length, token.length + 1];
    // People rarely mistype the first letter, so a typo keeps it, unless it swaps the first two.
    const firstLetterKept = word[0] === token[0] || (word[0] === token[1] && word[1] === token[0]);
    if (!firstLetterKept) continue;
    for (const length of lengths) {
      if (length > word.length) continue;
      const prefix = word.slice(0, length);
      if (swapOnly ? isSwap(token, prefix) : withinOneEdit(token, prefix)) {
        return { score: TYPO, start: index, end: index + length };
      }
    }
  }
  return best ?? (initials ? matchInitials(field, token) : null);
}

/**
 * Initials and word-start runs: each next letter of `token` either directly
 * follows the last one or starts a later word, so "fsl" and "fixsid" find
 * "Fix sidebar lag", as in VS Code. Every run but the last is one letter or
 * a whole word. Scattered letters would find any long title ("cron" in
 * "creation"). Weakest match, tried last.
 */
function matchInitials(field: SearchField, token: string): TokenMatch | null {
  if (token.length < 3 || DIGIT.test(token)) return null;
  const nextWordStart = (from: number, letter: string) => {
    for (let index = from; index < field.text.length; index++) {
      if (field.wordStarts[index] && field.text[index] === letter) return index;
    }
    return -1;
  };
  const runFrom = (start: number) => {
    const letters: SearchRange[] = [{ start, end: start + 1 }];
    let runStart = start;
    for (const letter of token.slice(1)) {
      const after = letters.at(-1)!.end;
      const at = field.text[after] === letter ? after : nextWordStart(after, letter);
      if (at === -1) return null;
      // Before the next word, a run is an initial or a whole word of three or
      // more letters ("fix" in "fixsid"). Anything else is a coincidence:
      // "lint" is not "Lin(k) t(hread)" or "l(akebed) in t(he)".
      const run = after - runStart;
      if (at !== after && run > 1 && (run < 3 || after !== wordEnd(field, runStart))) return null;
      if (at !== after) runStart = at;
      letters.push({ start: at, end: at + 1 });
    }
    return letters;
  };
  // "fis" in "Feature: Fix sidebar" starts at the second F.
  for (
    let start = nextWordStart(0, token[0]!);
    start !== -1;
    start = nextWordStart(start + 1, token[0]!)
  ) {
    const letters = runFrom(start);
    if (letters) return { score: INITIALS, start, end: letters.at(-1)!.end, letters };
  }
  return null;
}

interface WeightedSearchField {
  readonly value: string;
  readonly weight: number;
  /** Only a whole-word match counts, as for a short query against keywords. */
  readonly wholeWords?: boolean;
  /**
   * Only a match at a word start counts, without typos: hidden keywords that
   * matched loosely would list results the user cannot see why for.
   */
  readonly keyword?: boolean;
}

interface SearchFieldsMatch {
  /** Roughly 0.3 (weak) to 1.75 (exact title). */
  readonly quality: number;
  /** Every token matched at a word start, without a typo. */
  readonly strong: boolean;
  /** Source ranges matched in the first field, for highlighting. */
  readonly primaryRanges: ReadonlyArray<SearchRange>;
}

function toSourceRanges(field: SearchField, ranges: ReadonlyArray<SearchRange>): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const start = field.sourceIndex?.[range.start] ?? range.start;
    const end =
      range.end < field.text.length
        ? (field.sourceIndex?.[range.end] ?? range.end)
        : field.sourceLength;
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
    .map((field) => ({
      field: prepareSearchField(field.value),
      weight: field.weight,
      wholeWords: field.wholeWords ?? false,
      keyword: field.keyword ?? false,
    }));
  const primary = fields[0]?.value ? prepared[0]?.field : undefined;
  const tokens = normalizedQuery.split(" ");
  const primaryRanges: SearchRange[] = [];
  let total = 0;
  let strong = true;
  for (const token of tokens) {
    let best = 0;
    let bestPrimary: TokenMatch | null = null;
    let atWordStart = false;
    for (const { field, weight, wholeWords, keyword } of prepared) {
      if (best >= weight && field !== primary && atWordStart) continue;
      const typos = (options?.typos ?? false) && !keyword;
      // Initials only count in the name.
      const match = matchToken(field, token, typos, typos && field === primary);
      if (match === null || match.score < (wholeWords ? WHOLE_WORD : keyword ? 0.7 : 0)) continue;
      if (field === primary) bestPrimary = match;
      if (match.score >= 0.7) atWordStart = true;
      if (match.score * weight > best) best = match.score * weight;
    }
    if (best === 0) return null;
    strong &&= atWordStart;
    if (bestPrimary) primaryRanges.push(...(bestPrimary.letters ?? [bestPrimary]));
    total += best;
  }
  let quality = total / tokens.length;
  if (primary) {
    if (primary.text === normalizedQuery) quality += 0.5;
    else if (tokens.length > 1 && primary.text.includes(normalizedQuery)) quality += 0.25;
  }
  return {
    quality,
    strong,
    primaryRanges: primary ? toSourceRanges(primary, primaryRanges) : [],
  };
}

// A two-letter Latin substring of a message is noise rather than a match.
const MESSAGE_TOKEN_MIN_LENGTH = 3;

/**
 * Message search tokens, lowercased and NFC-composed but not stripped of
 * accents: the server's index folds Latin accents itself, and stripping marks
 * would break Korean and Japanese text. Every `long` token must appear in a
 * message; `short` ones only narrow those hits ("pnpm 12"). A query with no
 * long token searches no messages. Two CJK characters count as long.
 */
export function messageSearchTokens(query: string): {
  readonly long: ReadonlyArray<string>;
  readonly short: ReadonlyArray<string>;
} {
  const tokens = query
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const searchable = (token: string) => {
    const length = Array.from(token).length;
    return length >= MESSAGE_TOKEN_MIN_LENGTH || (length === 2 && hasCjkWord(token));
  };
  return {
    long: tokens.filter(searchable),
    short: tokens.filter((token) => !searchable(token)),
  };
}

// A message token shorter than this must start a word: "fts" is not in "drafts".
const MESSAGE_WORD_START_LENGTH = 4;
// Accented Latin letters by the letter they fold to: "e" -> "èéêë…".
let accentedLettersCache: Map<string, string> | null = null;
function accentedLetters(): Map<string, string> {
  if (accentedLettersCache) return accentedLettersCache;
  accentedLettersCache = new Map();
  for (let code = 0xc0; code <= 0x24f; code++) {
    const character = String.fromCharCode(code);
    const letter = foldCharacter(character);
    if (/^[a-z]$/.test(letter)) {
      accentedLettersCache.set(letter, (accentedLettersCache.get(letter) ?? "") + character);
    }
  }
  return accentedLettersCache;
}

/**
 * Matches text that holds an accented form of a letter in `token`, or null
 * when no letter has one. Only such text can hold the token through accents
 * ("res" in "Résumé"), so only it is folded, which is slow on long text.
 */
function accentedFormsOf(token: string): RegExp | null {
  const forms = Array.from(new Set(token), (letter) => accentedLetters().get(letter) ?? "").join(
    "",
  );
  return forms ? new RegExp(`[${forms}]`) : null;
}

// Where a word starts in `text`, by the rules of `foldSearchField`.
function startsWordAt(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  const character = text[index]!;
  return (
    !ALPHANUMERIC.test(previous) ||
    (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
    DIGIT.test(previous) !== DIGIT.test(character) ||
    isCjk(character)
  );
}

export interface MessageMatch {
  /** 1 when every token starts a word, MID_WORD when one only appears inside words. */
  readonly quality: number;
  /** Where a snippet should start to show the match. */
  readonly offset: number;
}

/**
 * How a message matches a query, so message hits rank like titles, or null
 * when a short token never starts a word in it ("fts" in "drafts"). Case and
 * accents are ignored, as in the server's index. Tokens too short for the
 * index ("12" in "pnpm 12") are the caller's to check.
 */
export function scoreMessageMatch(text: string, query: string): MessageMatch | null {
  const lowerText = text.toLowerCase();
  let folded: SearchField | null = null;
  let quality = 1;
  let offset = -1;
  for (const token of messageSearchTokens(query).long) {
    const short = Array.from(token).length < MESSAGE_WORD_START_LENGTH;
    const accents = short ? accentedFormsOf(token) : null;
    let first = -1;
    let wordStart = -1;
    for (
      let index = lowerText.indexOf(token);
      index !== -1 && wordStart === -1;
      index = lowerText.indexOf(token, index + 1)
    ) {
      if (first === -1) first = index;
      if (startsWordAt(text, index)) wordStart = index;
    }
    if (first === -1 || (wordStart === -1 && accents?.test(text))) {
      // Folding is per character, so bound it for very long messages.
      folded ??= foldSearchField(text.slice(0, 20_000));
      const foldedToken = foldSearchQuery(token);
      for (
        let index = folded.text.indexOf(foldedToken);
        index !== -1 && wordStart === -1;
        index = folded.text.indexOf(foldedToken, index + 1)
      ) {
        const source = folded.sourceIndex?.[index] ?? index;
        if (first === -1) first = source;
        if (folded.wordStarts[index]) wordStart = source;
      }
    }
    if (wordStart === -1) {
      if (short) return null;
      quality = MID_WORD;
    }
    const at = wordStart === -1 ? first : wordStart;
    if (at !== -1 && (offset === -1 || at < offset)) offset = at;
  }
  return { quality, offset: Math.max(offset, 0) };
}

/**
 * Ranges of `text` that contain a long message search token, for message
 * snippets, ignoring case and accents. Shorter tokens would light up half the
 * snippet, and a short long token only counts where it starts a word.
 * Snippets vary per query, so they skip the field cache.
 */
export function findSearchTokenRanges(text: string, query: string): SearchRange[] {
  const tokens = new Map(
    messageSearchTokens(query).long.map(
      (token) =>
        [foldSearchQuery(token), Array.from(token).length < MESSAGE_WORD_START_LENGTH] as const,
    ),
  );
  if (tokens.size === 0) return [];
  const field = foldSearchField(text);
  const ranges: SearchRange[] = [];
  for (const [token, needsWordStart] of tokens) {
    for (let index = field.text.indexOf(token); index !== -1;) {
      if (needsWordStart && !field.wordStarts[index]) {
        index = field.text.indexOf(token, index + 1);
        continue;
      }
      ranges.push({ start: index, end: index + token.length });
      index = field.text.indexOf(token, index + token.length);
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
/** Picked queries are stored this long; clients send no more. */
export const THREAD_SEARCH_PICK_MAX_LENGTH = 32;

function decay(ageMs: number): number {
  return 2 ** (-Math.max(0, ageMs) / SEARCH_RECENCY_HALF_LIFE_MS);
}

/** Server-stored open history; see `OrchestrationV2ThreadOpens`. */
export type ThreadOpenStats = OrchestrationV2ThreadOpens;

/**
 * Next open stats after an open at `at`. `query` is the palette query that
 * picked the thread, when it was opened from search.
 */
export function recordThreadOpen(
  previous: ThreadOpenStats | null,
  at: number,
  query: string | undefined,
): ThreadOpenStats {
  const pick = foldSearchQuery(query ?? "")
    .slice(0, THREAD_SEARCH_PICK_MAX_LENGTH)
    .trim();
  const queries = pick
    ? [pick, ...(previous?.queries ?? []).filter((existing) => existing !== pick)].slice(
        0,
        THREAD_SEARCH_PICK_LIMIT,
      )
    : (previous?.queries ?? []);
  const pickedAt = pick ? at : previous?.pickedAt;
  const picks = pickedAt === undefined ? {} : { pickedAt };
  if (previous !== null && at - previous.openedAt < THREAD_OPEN_DEDUPE_MS) {
    return { ...previous, ...picks, queries };
  }
  const score = previous === null ? 1 : previous.score * decay(at - previous.openedAt) + 1;
  return { openedAt: at, ...picks, score, queries };
}

export interface ThreadSearchSubject {
  /** Matched only by the whole query, like references. */
  readonly id?: string;
  readonly title: string;
  readonly branch?: string | null;
  readonly projectTitle?: string | null;
  /** Only set with two or more environments; it tells same-named threads apart. */
  readonly environmentLabel?: string | null;
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

// Use reorders matches of about the same quality but never turns a mid-word
// hit on a busy thread into a better result than a whole word on a quiet one.
const USE_BOOST_LIMIT = 2.5;

/**
 * How much use lifts a thread: 1 for a stale, never-opened thread, about 2 for
 * one active today, and up to 2.5 for threads opened often.
 */
function threadUsageBoost(thread: ThreadSearchSubject, now: number): number {
  const recency = thread.activityAt === null ? 0 : decay(now - thread.activityAt);
  const opens = thread.opens ? thread.opens.score * decay(now - thread.opens.openedAt) : 0;
  return Math.min(USE_BOOST_LIMIT, 1 + recency + 0.5 * Math.log2(1 + opens));
}

const REFERENCE_PREFIX_MIN = 8;

// IDs and URLs split into many word starts, so matching them as fields would
// let a two-letter query hit every thread. Only a long piece of one matches: a
// prefix, or, when it holds a digit like an ID or pull request number, any
// part ("t3code#22889", a URL without its scheme). Both are ASCII, so
// lowercasing is enough.
function matchReference(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
): SearchFieldsMatch | null {
  if (normalizedQuery.length < REFERENCE_PREFIX_MIN) return null;
  const references = [
    ...(thread.id ? [thread.id] : []),
    ...(thread.pullRequests ?? []).flatMap((pullRequest) => pullRequest.references ?? []),
  ];
  const anywhere = DIGIT.test(normalizedQuery);
  return references.some((reference) => {
    const folded = reference.toLowerCase();
    return anywhere ? folded.includes(normalizedQuery) : folded.startsWith(normalizedQuery);
  })
    ? { quality: 0.6, strong: true, primaryRanges: [] }
    : null;
}

// Strong enough that a thread you just picked for this query wins over a better
// but unused match. It fades from the last pick, so old picks let go even if
// the thread is opened in other ways.
const PICK_BOOST = 3;
// A remembered pick alone lists its thread (one picked through a message
// match, say), but two letters are too little to go on.
const PICK_ONLY_MIN_LENGTH = 3;

function pickBoost(thread: ThreadSearchSubject, normalizedQuery: string, now: number): number {
  const { opens } = thread;
  return opens?.queries.some((pick) => pick.startsWith(normalizedQuery))
    ? PICK_BOOST * decay(now - (opens.pickedAt ?? opens.openedAt))
    : 0;
}

export interface ThreadSearchMatch {
  /** Match quality times use; what results sort by. */
  readonly score: number;
  /** Match quality alone; see `rankSearchGroups`. */
  readonly quality: number;
  /** Every token matched at a word start; see `rankSearchGroups`. */
  readonly strong: boolean;
  readonly titleRanges: ReadonlyArray<SearchRange>;
  /** Why the thread matched when its title shows no match, for the result row. */
  readonly hint?: SearchMatchHint;
  /** Picked before for this query; see `rankSearchGroups`. */
  readonly picked?: boolean;
}

export interface SearchMatchHint {
  readonly label: string;
  readonly text: string;
  readonly ranges: ReadonlyArray<SearchRange>;
}

const PULL_REQUEST_WORDS = new Set(["pr", "prs", "pull", "pulls", "request", "requests"]);

/**
 * "pr 22889", "pr22889", and "pull request 22889" name a linked pull request:
 * once a token is one of its numbers, the words around it need not match.
 */
function withoutPullRequestWords(normalizedQuery: string, thread: ThreadSearchSubject): string {
  const numbers = new Set(
    (thread.pullRequests ?? []).map((pullRequest) => `${pullRequest.number}`),
  );
  if (numbers.size === 0) return normalizedQuery;
  const tokens = normalizedQuery
    .split(" ")
    .map((token) => token.replace(/^(?:#|pr|pull)(\d+)$/, "$1"));
  if (!tokens.some((token) => numbers.has(token))) return normalizedQuery;
  return tokens.filter((token) => !PULL_REQUEST_WORDS.has(token)).join(" ");
}

/** The first non-title field that holds the whole query, to explain the match. */
function matchHint(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
  typos: boolean,
): SearchMatchHint | undefined {
  const candidates: Array<{ readonly label: string; readonly text: string | null | undefined }> = [
    ...(thread.pullRequests ?? []).map((pullRequest) => ({
      label: "PR",
      text: `#${pullRequest.number}${pullRequest.title ? ` ${pullRequest.title}` : ""}`,
    })),
    { label: "Branch", text: thread.branch },
    { label: "Project", text: thread.projectTitle },
    { label: "Environment", text: thread.environmentLabel },
  ];
  for (const { label, text } of candidates) {
    if (!text) continue;
    const match = matchSearchFields(normalizedQuery, [{ value: text, weight: 1 }], { typos });
    if (match) return { label, text, ranges: match.primaryRanges };
  }
  return undefined;
}

/**
 * Scores a thread for a normalized query, or null when it does not match.
 * Titles and pull request numbers count fully, pull request titles and
 * branches less, project and environment names least.
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
  if (thread.environmentLabel) fields.push({ value: thread.environmentLabel, weight: 0.45 });
  const boost = pickBoost(thread, normalizedQuery, now);
  const fieldQuery = withoutPullRequestWords(normalizedQuery, thread).replace(/^#/, "");
  const fieldMatch = matchSearchFields(fieldQuery, fields, options);
  const referenceMatch = fieldMatch ? null : matchReference(normalizedQuery, thread);
  const pickOnly =
    !fieldMatch && !referenceMatch && boost > 0 && normalizedQuery.length >= PICK_ONLY_MIN_LENGTH;
  const match =
    fieldMatch ??
    referenceMatch ??
    (pickOnly ? { quality: 0.5, strong: false, primaryRanges: [] } : null);
  if (match === null) return null;
  const hint =
    match.primaryRanges.length > 0
      ? undefined
      : referenceMatch
        ? { label: "ID or link", text: normalizedQuery, ranges: [] }
        : pickOnly
          ? { label: "Picked before for", text: normalizedQuery, ranges: [] }
          : matchHint(fieldQuery, thread, options?.typos ?? false);
  return {
    score: match.quality * (threadUsageBoost(thread, now) + boost),
    quality: match.quality,
    strong: match.strong,
    titleRanges: match.primaryRanges,
    ...(hint ? { hint } : {}),
    ...(boost > 0 ? { picked: true } : {}),
  };
}

/** When the user last used a thread: their last message or their last open. */
export function threadRecentUse(thread: ThreadSearchSubject): number {
  return Math.max(thread.activityAt ?? 0, thread.opens?.openedAt ?? 0);
}

/**
 * Orders message matches from the server: matches where every query word
 * starts a word first, as for titles, then by the same use and pick signals
 * as title matches. `rank` is the match's position in its own environment's
 * results, which stand in for text relevance, so environments merge fairly.
 */
export function rankMessageMatches<
  T extends { readonly rank: number; readonly midWord?: boolean | undefined },
>(
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
    .sort(
      (left, right) =>
        Number(left.match.midWord === true) - Number(right.match.midWord === true) ||
        right.score - left.score,
    )
    .map(({ match }) => match);
}

/** Palette limits shared by web and mobile. */
export const PALETTE_THREAD_LIMIT = 20;
export const PALETTE_MESSAGE_LIMIT = 10;
/** Next to matching threads, other groups show only their best few rows. */
export const PALETTE_SECONDARY_LIMIT = 3;

// Every token at a word start of a main field (0.7 and up), a typo in a main
// field (0.4 and up), or weaker. Whole word against prefix is too fine a line
// for group order: "compact" must not lift a setting named "Compact…" over the
// thread "Compaction…". But "keybindngs" is the setting of that name, not a
// command that lists it as a keyword.
function matchClass(quality: number): number {
  return quality >= 0.7 ? 2 : quality >= 0.4 ? 1 : 0;
}

export interface RankedSearchItem<T, M> {
  readonly item: T;
  readonly match: M;
}

/**
 * Ranks grouped items, best score first within each group. Groups with no
 * match are dropped. The rest order by the class of their best match (word
 * starts in a name, typos in a name or keyword matches, or weaker), one class
 * higher for a result picked before for the query, and ties keep the given
 * order. Classes
 * rather than scores keep the group order steady while a word is typed, and
 * keep use, which only counts for threads, from outweighing a command that
 * matches as well.
 *
 * Typos are only tried when no result matches every token at a word start:
 * next to a real match, typo matches are noise ("enter" finding "external"),
 * but they should beat a mid-word accident ("ilde" in "Builder" for "idle").
 * Skipping them also keeps a keystroke cheap.
 */
export function rankSearchGroups<
  G,
  T,
  M extends {
    readonly score: number;
    readonly quality: number;
    readonly strong: boolean;
    readonly picked?: boolean;
  },
>(
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
  if (!ranked.some((entry) => entry.ranked.some(({ match }) => match.strong))) {
    ranked = rank(true);
  }
  return ranked
    .flatMap(({ group, ranked: items }, order) => {
      if (items.length === 0) return [];
      const sorted = [...items].sort((left, right) => right.match.score - left.match.score);
      const best = Math.max(
        ...items.map(({ match }) => matchClass(match.quality) + (match.picked ? 1 : 0)),
      );
      return [{ group, ranked: sorted, best, order }];
    })
    .sort((left, right) => right.best - left.best || left.order - right.order)
    .map(({ group, ranked: items }) => ({ group, ranked: items }));
}

/** `rankSearchGroups` for a single list. */
export function rankSearchItems<
  T,
  M extends { readonly score: number; readonly quality: number; readonly strong: boolean },
>(
  items: ReadonlyArray<T>,
  score: (item: T, options: { readonly typos: boolean }) => M | null,
): ReadonlyArray<RankedSearchItem<T, M>> {
  return rankSearchGroups([{ group: null, items }], score)[0]?.ranked ?? [];
}

export interface SearchTermsMatch {
  readonly score: number;
  readonly quality: number;
  readonly strong: boolean;
  readonly ranges: ReadonlyArray<SearchRange>;
}

const KEYWORD_QUALITY = 0.65;
// Below this, keyword prefixes match too much: "co" or "pro" would list most
// settings. A short query still matches a keyword it equals ("pr").
const KEYWORD_QUERY_MIN_LENGTH = 4;

/**
 * Scores a non-thread result such as a command or project. The first term
 * names it; the others are keywords that help it match but count less, so a
 * keyword match ranks a group below a name match ("mcp" finds the thread
 * named for it before a command with that keyword). Keywords match only at
 * word starts, and for queries under four characters only as whole words.
 */
export function scoreSearchTerms(
  normalizedQuery: string,
  terms: ReadonlyArray<string>,
  options?: { readonly typos?: boolean },
): SearchTermsMatch | null {
  const short = normalizedQuery.length < KEYWORD_QUERY_MIN_LENGTH;
  const match = matchSearchFields(
    normalizedQuery,
    terms.map((value, index) =>
      index === 0
        ? { value, weight: 1 }
        : // An alias typed in full ("pr") is deliberate, above a mere name prefix.
          { value, weight: short ? 0.8 : 0.6, wholeWords: short, keyword: true },
    ),
    options,
  );
  return (
    match && {
      score: match.quality,
      // Below the word-start class: a match only in hidden keywords must not put
      // its group above a result whose name matches.
      quality:
        match.primaryRanges.length > 0 ? match.quality : Math.min(match.quality, KEYWORD_QUALITY),
      strong: match.strong,
      ranges: match.primaryRanges,
    }
  );
}
