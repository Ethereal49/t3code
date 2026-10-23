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

import { WORKTREE_BRANCH_PREFIX } from "./git.ts";

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

/**
 * Letters search spells out, in both cases, as titles fold them and the
 * message index stores them ("ß" as "ss"). Unicode does not decompose them
 * into a base letter and a mark.
 */
export const SPELLED_OUT_LETTERS: Readonly<Record<string, string>> = {
  ß: "ss",
  ẞ: "ss",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ø: "o",
  Ø: "o",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
};
const SPELLED_OUT_LETTER = new RegExp(`[${Object.keys(SPELLED_OUT_LETTERS).join("")}]`, "gu");

/**
 * `text` with the letters search spells out ("ß" as "ss"), as the message
 * index stores them, so a typed "straße" also finds "Strasse".
 */
export function spellOutLetters(text: string): string {
  return text.replace(SPELLED_OUT_LETTER, (letter) => SPELLED_OUT_LETTERS[letter] ?? letter);
}

function foldCharacter(character: string): string {
  const folded = character.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
  return SPELLED_OUT_LETTERS[folded] ?? folded;
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

/**
 * Whether `character` starts a word after `previous` and `beforePrevious`
 * ("" at the start): after a non-letter, at a camelCase or digit boundary, or
 * at any Chinese or Japanese character. The one rule for titles and messages.
 */
function isWordStart(
  beforePrevious: string,
  previous: string,
  character: string,
  next: string,
): boolean {
  // "Julius’s": a possessive or contraction does not start a word.
  const afterApostrophe = APOSTROPHE.test(previous) && ALPHANUMERIC.test(beforePrevious);
  return (
    (ALPHANUMERIC.test(character) || SYMBOL.test(character)) &&
    !afterApostrophe &&
    (previous === "" ||
      !ALPHANUMERIC.test(previous) ||
      (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
      // The last capital of an acronym starts the next word: "JSONSchema".
      (UPPERCASE.test(previous) && UPPERCASE.test(character) && LOWERCASE.test(next)) ||
      DIGIT.test(previous) !== DIGIT.test(character) ||
      isCjk(character))
  );
}

function foldSearchField(source: string): SearchField {
  let text = "";
  const wordStarts: number[] = [];
  const sourceIndex: number[] = [];
  let identity = true;
  let previous = "";
  let beforePrevious = "";
  let index = 0;
  const characters = Array.from(source);
  for (const [position, character] of characters.entries()) {
    const startsWord = isWordStart(
      beforePrevious,
      previous,
      character,
      characters[position + 1] ?? "",
    );
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
  if (cached) return cached;
  // Oldest first out. A read does not re-insert: that would cost more than the
  // fold it saves, and the limit holds far more fields than a keystroke reads.
  if (fieldCache.size >= FIELD_CACHE_LIMIT) {
    fieldCache.delete(fieldCache.keys().next().value!);
  }
  const field = foldSearchField(source);
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
// Whole words typed together are exact, so they rank with typos and above
// mid-word hits, though below a match at a word start.
const JOINED_WORDS = 0.6;

interface TokenMatch extends SearchRange {
  readonly score: number;
  /** Separate ranges, for letters spread out across the field. */
  readonly letters?: ReadonlyArray<SearchRange>;
}

/**
 * Best match of one folded query token in a field. Tokens shorter than four
 * characters only match at a word start ("del" should not find "model"), and
 * longer ones only inside a word where `midWord` allows it. With
 * `typos`, a three-character token may swap a pair and a longer one may carry
 * one typo in a word prefix that keeps its first letter. Numbers never match
 * with a typo: 22889 is not pull request 22189. In the primary field (the
 * name), the token may also be whole words typed together (see `matchJoinedWords`), and with typos also
 * initials or word-start runs (see `matchInitials`).
 */
function matchToken(
  field: SearchField,
  token: string,
  typos: boolean,
  isPrimary: boolean,
  midWord: boolean,
): TokenMatch | null {
  if (token.length === 0) return null;
  let best: TokenMatch | null = null;
  const ownBoundary = !ALPHANUMERIC.test(token[0]!) && !SYMBOL.test(token[0]!);
  for (
    let index = field.text.indexOf(token);
    index !== -1;
    index = field.text.indexOf(token, index + 1)
  ) {
    // A token that opens with punctuation (".ts") brings its own boundary, as in messages.
    if (field.wordStarts[index] || ownBoundary) {
      // Whole when the match ends where a word ends: "t3c" is a prefix of
      // "t3code", ".ts" whole in "index.ts" but a prefix in "parser.tsx".
      const end = index + token.length;
      const whole =
        end >= field.text.length ||
        field.wordStarts[end] === 1 ||
        !ALPHANUMERIC.test(field.text[end]!);
      let runEnd = end;
      while (runEnd < field.text.length && ALPHANUMERIC.test(field.text[runEnd]!)) runEnd++;
      const score = whole ? WHOLE_WORD : 0.7 + (0.2 * token.length) / (runEnd - index);
      if (best === null || score > best.score) {
        best = { score, start: index, end: index + token.length };
      }
      if (score === WHOLE_WORD) return best;
    } else if (midWord && token.length >= 4 && best === null) {
      best = { score: MID_WORD, start: index, end: index + token.length };
    }
  }
  // Joined words are exact, so they count without the typo pass: a strong
  // match elsewhere must not hide "VS Code" for "vscode".
  if ((best === null || best.score <= MID_WORD) && isPrimary) {
    const joined = matchJoinedWords(field, token);
    if (joined) return joined;
  }
  if ((best !== null && best.score > MID_WORD) || !typos || token.length < 3) return best;
  // Numbers skip typos (22889 is not 22189) but keep initials: "pnpm12" is "pnpm 12".
  if (!DIGIT.test(token)) {
    for (let index = 0; index < field.text.length; index++) {
      if (!field.wordStarts[index]) continue;
      // The whole run, across camelCase joins: "githbu" is "GitHub".
      let runEnd = index + 1;
      while (runEnd < field.text.length && ALPHANUMERIC.test(field.text[runEnd]!)) runEnd++;
      const word = field.text.slice(index, runEnd);
      // Short tokens only forgive a swapped pair: any other edit of a three- or
      // four-letter word matches too much ("cron" would find every "con…").
      const swapOnly = token.length <= 4;
      // The same length first, so "githbu" highlights all of "GitHub".
      const lengths = swapOnly
        ? [token.length]
        : [token.length, token.length - 1, token.length + 1];
      // People rarely mistype the first letter, so a typo keeps it, unless it
      // swaps the first two of a longer word ("ing" is not "nig…").
      const firstLetterKept =
        word[0] === token[0] || (token.length > 3 && word[0] === token[1] && word[1] === token[0]);
      if (!firstLetterKept) continue;
      for (const length of lengths) {
        if (length > word.length) continue;
        const prefix = word.slice(0, length);
        if (swapOnly ? isSwap(token, prefix) : withinOneEdit(token, prefix)) {
          return { score: TYPO, start: index, end: index + length };
        }
      }
    }
  }
  return best ?? (typos && isPrimary ? matchInitials(field, token) : null);
}

/**
 * Whole words typed together: "vscode" is "VS Code", "fixuibug" is "Fix UI
 * bug". Every part is a whole word but the last, which may be a prefix. Kept
 * apart from initials, where two-letter runs would also find "l(akebed)
 * in t(he)" for "lint".
 */
function matchJoinedWords(field: SearchField, token: string): TokenMatch | null {
  for (let start = 0; start < field.text.length; start++) {
    if (!field.wordStarts[start] || field.text[start] !== token[0]) continue;
    const letters: SearchRange[] = [];
    let at = start;
    let rest = token;
    let lastWhole = false;
    while (rest.length > 0 && at < field.text.length) {
      const end = wordEnd(field, at);
      const word = field.text.slice(at, end);
      if (word.startsWith(rest)) {
        letters.push({ start: at, end: at + rest.length });
        lastWhole = rest.length === word.length;
        rest = "";
      } else if (rest.startsWith(word)) {
        letters.push({ start: at, end });
        rest = rest.slice(word.length);
        at = end;
        while (at < field.text.length && !field.wordStarts[at]) at++;
      } else {
        break;
      }
    }
    // Short words before a short prefix are a coincidence inside a title
    // ("inth" is not "in th(read)"), but not at its start ("t3co" is "T3
    // Co(de)"), before three letters ("gomod"), or a whole word ("vscode").
    const shortBefore = letters.slice(0, -1).some((range) => range.end - range.start < 3);
    const atStart = start === field.wordStarts.indexOf(1);
    const last = letters.at(-1);
    const lastLong = last !== undefined && last.end - last.start >= 3;
    if (
      rest.length === 0 &&
      letters.length > 1 &&
      (lastWhole || lastLong || atStart || !shortBefore)
    ) {
      return { score: JOINED_WORDS, start, end: letters.at(-1)!.end, letters };
    }
  }
  return null;
}

/**
 * Initials and word-start runs: each next letter of `token` either directly
 * follows the last one or starts the next word, so "fsl" and "fixsid" find
 * "Fix sidebar lag", as in VS Code. Every run but the last is one letter or
 * a whole word. Scattered letters would find any long title ("cron" in
 * "creation"). Weakest match, tried last.
 */
function matchInitials(field: SearchField, token: string): TokenMatch | null {
  if (token.length < 3 || /^\p{N}+$/u.test(token)) return null;
  const nextWordStart = (from: number, letter: string) => {
    for (let index = from; index < field.text.length; index++) {
      if (field.wordStarts[index] && field.text[index] === letter) return index;
    }
    return -1;
  };
  const followingWordStart = (from: number) => {
    for (let index = from; index < field.text.length; index++) {
      if (field.wordStarts[index]) return index;
    }
    return -1;
  };
  const runFrom = (start: number) => {
    const letters: SearchRange[] = [{ start, end: start + 1 }];
    let runStart = start;
    for (const letter of token.slice(1)) {
      const after = letters.at(-1)!.end;
      // The very next word, not any later one: "fts" is not spread over nine.
      const next = followingWordStart(after);
      const at =
        field.text[after] === letter
          ? after
          : next !== -1 && field.text[next] === letter
            ? next
            : -1;
      if (at === -1) return null;
      // Before the next word, a run is an initial or a whole word of three or
      // more letters ("fix" in "fixsid"). Anything else is a coincidence:
      // "lint" is not "Lin(k) t(hread)" or "l(akebed) in t(he)".
      const run = after - runStart;
      const endsWord =
        after === field.text.length ||
        field.wordStarts[after] === 1 ||
        !ALPHANUMERIC.test(field.text[after]!);
      if (at !== after && run > 1 && (run < 3 || !endsWord)) return null;
      if (at !== after) runStart = at;
      letters.push({ start: at, end: at + 1 });
    }
    return letters;
  };
  // "fixsid" in "Feature: Fix sidebar" starts at the second F.
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
  /**
   * Where the thread lives (project, environment): it helps a match, but a
   * word start there does not make the match strong, so it never turns off
   * joined words or typos for the titles.
   */
  readonly context?: boolean;
  /**
   * A token of four or more letters may match inside a word here. Only thread
   * titles allow it: inside a command name or a branch it reads as junk
   * ("arch" in "Search").
   */
  readonly midWord?: boolean;
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
      context: field.context ?? false,
      allowMidWord: field.midWord ?? false,
    }));
  const primary = fields[0]?.value ? prepared[0]?.field : undefined;
  // An empty token would match everywhere, and loop forever in `matchToken`.
  const tokens = normalizedQuery.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const primaryRanges: SearchRange[] = [];
  let total = 0;
  let strong = true;
  for (const token of tokens) {
    let best = 0;
    let bestPrimary: TokenMatch | null = null;
    let atWordStart = false;
    for (const { field, weight, wholeWords, keyword, context, allowMidWord } of prepared) {
      if (best >= weight && field !== primary && atWordStart) continue;
      const typos = (options?.typos ?? false) && !keyword;
      // Joined words and initials only count in the name.
      const match = matchToken(field, token, typos, field === primary, allowMidWord);
      if (match === null || match.score < (wholeWords ? WHOLE_WORD : keyword ? 0.7 : 0)) continue;
      if (field === primary) bestPrimary = match;
      if (match.score >= 0.7 && !context) atWordStart = true;
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
const MESSAGE_PREFIX = 0.8;
// Accented Latin letters by the letter they fold to: "e" -> "èéêë…".
let accentedLettersCache: Map<string, string> | null = null;
function accentedLetters(): Map<string, string> {
  if (accentedLettersCache) return accentedLettersCache;
  accentedLettersCache = new Map();
  // Latin-1 Supplement, Extended-A and -B, and Extended Additional ("ế").
  const codes = [
    ...Array.from({ length: 0x24f - 0xc0 + 1 }, (_, offset) => 0xc0 + offset),
    ...Array.from({ length: 0x1eff - 0x1e00 + 1 }, (_, offset) => 0x1e00 + offset),
  ];
  for (const code of codes) {
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

// Whether a word ends right before `end` in `text`.
function endsWordAt(text: string, end: number): boolean {
  return end >= text.length || !ALPHANUMERIC.test(text[end]!) || startsWordAt(text, end);
}

function startsWordAt(text: string, index: number): boolean {
  const character = text[index]!;
  // A token that opens with punctuation (".ts", "#22889") brings its own boundary.
  if (!ALPHANUMERIC.test(character) && !SYMBOL.test(character)) return true;
  return isWordStart(
    text[index - 2] ?? "",
    text[index - 1] ?? "",
    character,
    text[index + 1] ?? "",
  );
}

export interface MessageMatch {
  /**
   * 1 when every token is a whole word, MESSAGE_PREFIX when one only starts
   * a word ("mode" in "model"), MID_WORD when one only appears inside words.
   */
  readonly quality: number;
  /** A token only appears inside words, so the match ranks below word matches. */
  readonly midWord: boolean;
  /** Where a snippet should start to show the match. */
  readonly offset: number;
}

/**
 * How a message matches a query, so message hits rank like titles, or null
 * when a short token never starts a word in it ("fts" in "drafts"). Case and
 * accents are ignored, as in the server's index. Tokens too short for the
 * index ("12" in "pnpm 12") are the caller's to check.
 */
// Accents written as separate combining marks ("e" + "\u0301").
const HAS_MARK = /\p{M}/u;
// Letters `foldCharacter` expands, which native normalization does not.
const EXPANDING_LETTER = new RegExp(`[${Object.keys(SPELLED_OUT_LETTERS).join("")}]`, "u");

/** `text` lowercased without changing its length, so offsets stay valid ("İ" grows). */
function lowerCaseInPlace(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  return Array.from(text, (character) => {
    const folded = character.toLowerCase();
    return folded.length === character.length ? folded : character;
  }).join("");
}

interface FoldedMessage {
  readonly text: string;
  sourceAt(index: number): number;
  startsWord(index: number): boolean;
  endsWord(end: number): boolean;
}

/**
 * A message with case and accents folded, for matches the plain search
 * missed. Native normalization keeps one character per source character for
 * most text, so it folds a message of any length cheaply and word starts come
 * from the source. Text it would shift (decomposed accents, ligatures) is
 * folded character by character with source positions, ASCII taking a fast
 * path, so it also reads the whole message.
 */
function foldMessage(text: string): FoldedMessage {
  const native = text.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
  // Marks already in the text, or letters that expand, could leave the length
  // equal by chance while positions shift.
  if (native.length === text.length && !HAS_MARK.test(text) && !EXPANDING_LETTER.test(text)) {
    return {
      text: native,
      sourceAt: (index) => index,
      startsWord: (index) => startsWordAt(text, index),
      endsWord: (end) => endsWordAt(text, end),
    };
  }
  let folded = "";
  const sourceIndex: number[] = [];
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[index];
      sourceIndex.push(index);
      index += 1;
      continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    for (const unit of foldCharacter(character).split("")) {
      folded += unit;
      sourceIndex.push(index);
    }
    index += character.length;
  }
  const sourceAt = (index: number) => sourceIndex[index] ?? text.length;
  return {
    text: folded,
    sourceAt,
    startsWord: (index) => startsWordAt(text, sourceAt(index)),
    endsWord: (end) => end >= folded.length || endsWordAt(text, sourceAt(end)),
  };
}

interface PreparedMessageQuery {
  readonly query: string;
  readonly tooShort: ReadonlyArray<string>;
  readonly tokens: ReadonlyArray<{
    readonly token: string;
    readonly foldedToken: string;
    readonly short: boolean;
    readonly accents: RegExp | null;
  }>;
}

// The server scores up to thousands of hits for one query, so its tokens are
// prepared once.
let lastMessageQuery: PreparedMessageQuery | null = null;

function prepareMessageQuery(query: string): PreparedMessageQuery {
  if (lastMessageQuery?.query === query) return lastMessageQuery;
  const { long, short } = messageSearchTokens(query);
  lastMessageQuery = {
    query,
    tooShort: short,
    tokens: long.map((token) => ({
      token,
      foldedToken: foldSearchQuery(token),
      short: Array.from(token).length < MESSAGE_WORD_START_LENGTH,
      accents: accentedFormsOf(token),
    })),
  };
  return lastMessageQuery;
}

export function scoreMessageMatch(text: string, query: string): MessageMatch | null {
  const lowerText = lowerCaseInPlace(text);
  let folded: FoldedMessage | null = null;
  let quality = 1;
  let offset = -1;
  const prepared = prepareMessageQuery(query);
  // Too short for the index, so the caller only checked them as substrings:
  // "on" must start a word, not sit inside "connection".
  for (const token of prepared.tooShort) {
    let index = lowerText.indexOf(token);
    while (index !== -1 && !startsWordAt(text, index)) index = lowerText.indexOf(token, index + 1);
    if (index === -1) return null;
  }
  for (const { token, foldedToken, short, accents } of prepared.tokens) {
    let first = -1;
    let wordStart = -1;
    let wholeWord = -1;
    for (
      let index = lowerText.indexOf(token);
      index !== -1 && wholeWord === -1;
      index = lowerText.indexOf(token, index + 1)
    ) {
      if (first === -1) first = index;
      if (!startsWordAt(text, index)) continue;
      if (wordStart === -1) wordStart = index;
      if (endsWordAt(text, index + token.length)) wholeWord = index;
    }
    if (
      foldedToken.length > 0 &&
      (first === -1 ||
        (wholeWord === -1 &&
          (accents?.test(text) || HAS_MARK.test(text) || EXPANDING_LETTER.test(text))))
    ) {
      folded ??= foldMessage(text);
      for (
        let index = folded.text.indexOf(foldedToken);
        index !== -1 && wholeWord === -1;
        index = folded.text.indexOf(foldedToken, index + 1)
      ) {
        const source = folded.sourceAt(index);
        if (first === -1) first = source;
        if (!folded.startsWord(index)) continue;
        if (wordStart === -1) wordStart = source;
        if (folded.endsWord(index + foldedToken.length)) wholeWord = source;
      }
    }
    if (wordStart === -1 && short) return null;
    quality = Math.min(
      quality,
      wholeWord !== -1 ? 1 : wordStart !== -1 ? MESSAGE_PREFIX : MID_WORD,
    );
    const at = wholeWord !== -1 ? wholeWord : wordStart !== -1 ? wordStart : first;
    if (at !== -1 && (offset === -1 || at < offset)) offset = at;
  }
  return { quality, midWord: quality <= MID_WORD, offset: Math.max(offset, 0) };
}

/**
 * Ranges of `text` that contain a long message search token, for message
 * snippets, ignoring case and accents. Shorter tokens would light up half the
 * snippet, and a short long token only counts where it starts a word.
 * Snippets vary per query, so they skip the field cache.
 */
export function findSearchTokenRanges(text: string, query: string): SearchRange[] {
  const tokens = new Map(
    messageSearchTokens(query)
      .long.map(
        (token) =>
          [foldSearchQuery(token), Array.from(token).length < MESSAGE_WORD_START_LENGTH] as const,
      )
      // Some tokens fold to nothing ("´´´"), which would match everywhere.
      .filter(([token]) => token.length > 0),
  );
  if (tokens.size === 0) return [];
  const field = foldSearchField(text);
  const ranges: SearchRange[] = [];
  for (const [token, needsWordStart] of tokens) {
    // A token that opens with punctuation brings its own boundary, as in scoring.
    const ownBoundary = !ALPHANUMERIC.test(token[0]!) && !SYMBOL.test(token[0]!);
    for (let index = field.text.indexOf(token); index !== -1;) {
      if (needsWordStart && !ownBoundary && !field.wordStarts[index]) {
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
const THREAD_SEARCH_PICK_MAX_LENGTH = 32;

/**
 * `query` as a pick is stored and compared: folded, then cut to the stored
 * length without splitting an emoji in two. Clients and the server both use
 * it, so a long pick matches its query again.
 */
export function pickedQuery(query: string): string {
  const cut = foldSearchQuery(query).slice(0, THREAD_SEARCH_PICK_MAX_LENGTH);
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
}

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
  const pick = pickedQuery(query ?? "");
  // Picks that no longer count are not kept or synced.
  const earlier = (previous?.picks ?? []).filter((entry) => at - entry.at <= PICK_WINDOW_MS);
  const picks = pick
    ? [{ query: pick, at }, ...earlier.filter((entry) => entry.query !== pick)].slice(
        0,
        THREAD_SEARCH_PICK_LIMIT,
      )
    : earlier;
  if (previous !== null && at - previous.openedAt < THREAD_OPEN_DEDUPE_MS) {
    return { ...previous, picks };
  }
  const score = previous === null ? 1 : previous.score * decay(at - previous.openedAt) + 1;
  return { openedAt: at, score, picks };
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

// How long a pick lasts. While it does, typing the query again (or the start of
// it) puts the thread first in its group, the latest pick first. The exact
// query also lifts its group above commands that match as well; a prefix does
// not, so the groups hold still while a word is typed. It runs from the pick,
// so an old pick lets go even if the thread is opened in other ways.
const PICK_WINDOW_MS = 21 * DAY_MS;
// A remembered pick alone lists its thread (one picked through a message
// match, say), but two letters are too little to go on.
const PICK_ONLY_MIN_LENGTH = 3;

/** The latest pick of the thread for this query, while it lasts. */
function activePick(
  thread: ThreadSearchSubject,
  normalizedQuery: string,
  now: number,
): ThreadOpenStats["picks"][number] | undefined {
  // Stored picks are cut to a length, so compare the query cut the same way.
  const query = pickedQuery(normalizedQuery);
  // The start of a picked query counts from three letters: "n" is too little
  // to go on, and would flip the group order between keystrokes.
  const prefix = query.length >= PICK_ONLY_MIN_LENGTH;
  // The latest exact pick, else the latest pick the query starts.
  let exact: ThreadOpenStats["picks"][number] | undefined;
  let latest: ThreadOpenStats["picks"][number] | undefined;
  for (const pick of thread.opens?.picks ?? []) {
    if (now - pick.at > PICK_WINDOW_MS) continue;
    if (pick.query === query && (exact === undefined || pick.at > exact.at)) exact = pick;
    const matches = pick.query === query || (prefix && pick.query.startsWith(query));
    if (matches && (latest === undefined || pick.at > latest.at)) latest = pick;
  }
  return exact ?? latest;
}

export interface ThreadSearchMatch {
  /** Match quality times use; what results sort by. */
  readonly score: number;
  /** Match quality alone; see `rankSearchGroups`. */
  readonly quality: number;
  /** Every token matched at a word start; see `rankSearchGroups`. */
  readonly strong: boolean;
  readonly titleRanges: ReadonlyArray<SearchRange>;
  /**
   * Why the thread matched when its title shows no match, for the result row.
   * Built on demand, so only the rows shown pay for it.
   */
  readonly explain?: () => SearchMatchHint | undefined;
  /** When the thread was picked for this query, while that pick lasts; see `rankSearchGroups`. */
  readonly pickedAt?: number;
  /** Picked for exactly this query, which also lifts its group; see `rankSearchGroups`. */
  readonly pickedExactly?: boolean;
}

export interface SearchMatchHint {
  readonly label: string;
  readonly text: string;
  readonly ranges: ReadonlyArray<SearchRange>;
}

// Most threads' branches start with the app's own worktree prefix ("t3/", and
// "t3code/" before it), so "t3 connect" would match nearly every thread.
const WORKTREE_BRANCH_PREFIX_PATTERN = new RegExp(`^(?:${WORKTREE_BRANCH_PREFIX}|t3code)/`);

function searchableBranch(branch: string | null | undefined): string | null {
  return branch ? branch.replace(WORKTREE_BRANCH_PREFIX_PATTERN, "") : null;
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
    { label: "Branch", text: searchableBranch(thread.branch) },
    { label: "Project", text: thread.projectTitle },
    { label: "Environment", text: thread.environmentLabel },
  ];
  const rangesIn = (text: string, query: string) =>
    matchSearchFields(query, [{ value: text, weight: 1 }], { typos })?.primaryRanges;
  for (const { label, text } of candidates) {
    const ranges = text ? rangesIn(text, normalizedQuery) : undefined;
    if (text && ranges) return hintNearMatch(label, text, ranges);
  }
  // A query split across fields ("cleanup payloads" in a branch and a PR
  // title): the first field that holds some of its words.
  const tokens = normalizedQuery.split(" ").filter((token) => token.length > 0);
  if (tokens.length <= 1) return undefined;
  for (const { label, text } of candidates) {
    if (!text) continue;
    const present = tokens.filter((token) => rangesIn(text, token));
    const ranges = present.length > 0 ? rangesIn(text, present.join(" ")) : undefined;
    if (ranges) return hintNearMatch(label, text, ranges);
  }
  return undefined;
}

// Rows show one line, so a long pull request title or branch is cut to start a
// few characters before the match, at a word, as message snippets are.
const HINT_LEAD = 12;
function hintNearMatch(
  label: string,
  text: string,
  ranges: ReadonlyArray<SearchRange>,
): SearchMatchHint {
  const first = ranges[0]?.start ?? 0;
  if (first <= HINT_LEAD * 2) return { label, text, ranges };
  let start = first - HINT_LEAD;
  const space = text.indexOf(" ", start);
  if (space !== -1 && space < first) start = space + 1;
  return {
    label,
    text: `…${text.slice(start)}`,
    ranges: ranges.map((range) => ({ start: range.start - start + 1, end: range.end - start + 1 })),
  };
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
  options?: {
    readonly typos?: boolean;
    /**
     * Palette picks; off where a pick would show up unexplained, such as a
     * sidebar filter or an agent's search.
     */
    readonly picks?: boolean;
  },
): ThreadSearchMatch | null {
  const fields: WeightedSearchField[] = [{ value: thread.title, weight: 1, midWord: true }];
  for (const pullRequest of thread.pullRequests ?? []) {
    fields.push({ value: `#${pullRequest.number}`, weight: 1 });
    if (pullRequest.title) fields.push({ value: pullRequest.title, weight: 0.5 });
  }
  const branch = searchableBranch(thread.branch);
  if (branch) fields.push({ value: branch, weight: 0.6 });
  if (thread.projectTitle) {
    fields.push({ value: thread.projectTitle, weight: 0.25, context: true });
  }
  if (thread.environmentLabel) {
    fields.push({ value: thread.environmentLabel, weight: 0.25, context: true });
  }
  const pick = options?.picks === false ? undefined : activePick(thread, normalizedQuery, now);
  const pickedAt = pick?.at;
  // "#22889" and a pasted "t3/branch" search without their prefixes, as the
  // branch field is stored without the app's worktree prefix.
  const fieldQuery = withoutPullRequestWords(normalizedQuery, thread)
    .replace(/^#\s*/, "")
    .replace(WORKTREE_BRANCH_PREFIX_PATTERN, "");
  const fieldMatch = matchSearchFields(fieldQuery, fields, options);
  const referenceMatch = fieldMatch ? null : matchReference(normalizedQuery, thread);
  const pickOnly =
    !fieldMatch &&
    !referenceMatch &&
    pickedAt !== undefined &&
    normalizedQuery.length >= PICK_ONLY_MIN_LENGTH;
  const match =
    fieldMatch ??
    referenceMatch ??
    (pickOnly ? { quality: 0.5, strong: false, primaryRanges: [] } : null);
  if (match === null) return null;
  const explain =
    match.primaryRanges.length > 0
      ? undefined
      : (): SearchMatchHint | undefined =>
          referenceMatch
            ? { label: "ID or link", text: normalizedQuery, ranges: [] }
            : pickOnly
              ? { label: "Picked before for", text: pick!.query, ranges: [] }
              : matchHint(fieldQuery, thread, options?.typos ?? false);
  return {
    score: match.quality * threadUsageBoost(thread, now),
    quality: match.quality,
    strong: match.strong,
    titleRanges: match.primaryRanges,
    ...(explain ? { explain } : {}),
    ...(pickedAt === undefined ? {} : { pickedAt }),
    ...(pick?.query === pickedQuery(normalizedQuery) ? { pickedExactly: true } : {}),
  };
}

/** When the user last used a thread: their last message or their last open. */
export function threadRecentUse(thread: ThreadSearchSubject): number {
  return Math.max(thread.activityAt ?? 0, thread.opens?.openedAt ?? 0);
}

/**
 * How strongly a thread's messages match among matches of one quality: more
 * for a thread that keeps using the word than for a passing mention, up to
 * twice as much at about thirty matching messages.
 */
export function messageMatchWeight(hits: number): number {
  return 1 + Math.min(Math.log2(1 + hits), 5) / 5;
}

/**
 * Orders message matches from the server, from any number of environments:
 * by match quality (whole words, then word prefixes, then inside words), then
 * threads picked for the query, then hit count times use, then the newest
 * message.
 */
export function rankMessageMatches<
  T extends {
    readonly quality?: number;
    readonly hits?: number;
    readonly messageCreatedAt?: string | null;
  },
>(
  matches: ReadonlyArray<T>,
  subjectOf: (match: T) => ThreadSearchSubject | undefined,
  normalizedQuery: string,
  now: number,
  options?: { readonly picks?: boolean },
): T[] {
  return matches
    .flatMap((match) => {
      const subject = subjectOf(match);
      if (!subject) return [];
      // Older servers send no quality; their matches count as words.
      const quality = match.quality ?? 1;
      return [
        {
          match,
          quality,
          pickedAt:
            options?.picks === false ? 0 : (activePick(subject, normalizedQuery, now)?.at ?? 0),
          score: messageMatchWeight(match.hits ?? 1) * threadUsageBoost(subject, now),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.quality - left.quality ||
        right.pickedAt - left.pickedAt ||
        right.score - left.score ||
        (right.match.messageCreatedAt ?? "").localeCompare(left.match.messageCreatedAt ?? ""),
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
 * Ranks grouped items: within a group, results picked for the query first
 * (latest pick first), then by match class, then best score. Groups with no match are dropped. The
 * rest order by the class of their best match (word starts in a name, typos in
 * a name or keyword matches, or weaker), one class higher for a result picked
 * for exactly this query, and ties keep the given order. Classes
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
    readonly pickedAt?: number;
    readonly pickedExactly?: boolean;
    readonly groupQuality?: number;
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
      // Use decides within a match class, never across one: a busy thread
      // matched through its project does not pass a title that holds the words.
      const sorted = [...items].sort(
        (left, right) =>
          Number(right.match.pickedExactly ?? false) - Number(left.match.pickedExactly ?? false) ||
          (right.match.pickedAt ?? 0) - (left.match.pickedAt ?? 0) ||
          matchClass(right.match.quality) - matchClass(left.match.quality) ||
          right.match.score - left.match.score,
      );
      const best = Math.max(
        ...items.map(
          ({ match }) =>
            matchClass(match.groupQuality ?? match.quality) + (match.pickedExactly ? 1 : 0),
        ),
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
  /** The quality its group ranks by, when lower; see `scoreSearchTerms`. */
  readonly groupQuality?: number;
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
      quality: match.quality,
      // Below the word-start class: a match only in hidden keywords must not put
      // its group above a result whose name matches. Inside the group an exact
      // alias still beats a name prefix ("pr" lists "Open pull requests" first).
      ...(match.primaryRanges.length > 0
        ? {}
        : { groupQuality: Math.min(match.quality, KEYWORD_QUALITY) }),
      strong: match.strong,
      ranges: match.primaryRanges,
    }
  );
}
