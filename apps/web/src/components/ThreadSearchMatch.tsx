import {
  findSearchTokenRanges,
  normalizeSearchQuery,
  splitSearchText,
  type SearchRange,
} from "@t3tools/shared/searchRank";

/** `text` with each range in semibold foreground. */
export function HighlightedSearchText(props: { text: string; ranges: ReadonlyArray<SearchRange> }) {
  if (props.ranges.length === 0) return props.text;
  return splitSearchText(props.text, props.ranges).map((part) =>
    part.highlighted ? (
      <mark className="bg-transparent font-semibold text-foreground" key={part.start}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

export function ThreadSearchMatchExcerpt(props: {
  match: {
    readonly source: "user" | "assistant";
    readonly snippet: string;
    readonly query: string;
  };
}) {
  const isUser = props.match.source === "user";
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>
        {isUser ? "You:" : "Agent:"}
      </span>{" "}
      <HighlightedSearchText
        text={props.match.snippet}
        ranges={findSearchTokenRanges(props.match.snippet, normalizeSearchQuery(props.match.query))}
      />
    </span>
  );
}
