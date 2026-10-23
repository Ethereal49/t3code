import {
  GUEST_MESSAGE_MAX_LENGTH,
  GUEST_NAME_MAX_LENGTH,
  GUEST_ROUTE_PREFIX,
  type GuestRedeemRequest,
  type GuestShareView,
  type GuestSubmitRequest,
  type GuestTranscriptItem,
  type ThreadGuestMessageStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useReducer, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  applyGuestStreamEvent,
  initialGuestStreamState,
  parseGuestStreamEvent,
} from "./guestStream.logic";

let capturedInvite: { readonly credential: string | null } | null = null;

/**
 * The invite credential travels in the URL hash so it never reaches a server log. It is read
 * once and removed from history, so it lives only in memory. Opening the page never redeems it:
 * only submitting a name does, so a reload before that leaves the link usable.
 */
function takeInviteCredential(): string | null {
  if (capturedInvite === null) {
    const credential = decodeURIComponent(window.location.hash.slice(1)).trim();
    if (window.location.hash !== "") {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
    capturedInvite = { credential: credential === "" ? null : credential };
  }
  return capturedInvite.credential;
}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

/** Resolves to null on success, or to a message the guest can read. */
async function postGuest(
  path: "redeem" | "messages",
  body: typeof GuestRedeemRequest.Encoded | typeof GuestSubmitRequest.Encoded,
): Promise<string | null> {
  try {
    const response = await fetch(`${GUEST_ROUTE_PREFIX}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const json: unknown = await response.json().catch(() => null);
    return Option.match(decodeErrorBody(json), {
      onNone: () => "Something went wrong. Try again.",
      onSome: ({ message }) => message,
    });
  } catch {
    return "Could not reach the server.";
  }
}

const STATUS_LABEL: Record<ThreadGuestMessageStatus, string> = {
  pending: "Waiting for approval",
  sent: "Sent",
  dismissed: "Dismissed",
};

export function GuestPage() {
  const [credential] = useState(takeInviteCredential);
  // An invite always starts at the name form: a cookie from an earlier share on this host must
  // not stand in for the thread this link points at.
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    delete root.dataset.themeId;
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-black text-white">
      {credential !== null && !joined ? (
        <NameForm credential={credential} onJoined={() => setJoined(true)} />
      ) : (
        <GuestSession />
      )}
    </div>
  );
}

function GuestSession() {
  const [stream, dispatch] = useReducer(applyGuestStreamEvent, initialGuestStreamState);
  // EventSource closes for good only on a non-200 response, which the guest routes send for a
  // missing, invalid, or ended session. Network drops reconnect on their own.
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    if (stream.view) document.title = stream.view.title;
  }, [stream.view]);

  useEffect(() => {
    const source = new EventSource(`${GUEST_ROUTE_PREFIX}/stream`);
    source.addEventListener("message", (message) => {
      const event = parseGuestStreamEvent(message.data);
      if (event === null) return;
      dispatch(event);
      if (event.type === "ended") source.close();
    });
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) setRejected(true);
    });
    return () => source.close();
  }, []);

  if (stream.ended || (rejected && stream.view !== null)) {
    return <Notice text="This link has ended." />;
  }
  if (stream.view !== null) return <GuestThread view={stream.view} items={stream.items} />;
  if (!rejected) return <Notice text="Connecting..." />;
  return <Notice text="This link has ended or is not valid." />;
}

function Notice({ text }: { readonly text: string }) {
  return <p className="m-auto p-6 text-sm text-white/70">{text}</p>;
}

function NameForm({
  credential,
  onJoined,
}: {
  readonly credential: string;
  readonly onJoined: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    const failure = await postGuest("redeem", { credential, name: trimmed });
    setSubmitting(false);
    if (failure === null) onJoined();
    else setError(failure);
  };
  return (
    <form className="m-auto flex w-full max-w-sm flex-col gap-3 p-6" onSubmit={submit}>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="guest-name">
        Your name
        <Input
          id="guest-name"
          autoFocus
          autoComplete="name"
          maxLength={GUEST_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || name.trim() === ""}>
        Join
      </Button>
    </form>
  );
}

function GuestThread({
  view: { title, working, messages },
  items,
}: {
  readonly view: GuestShareView;
  readonly items: ReadonlyArray<GuestTranscriptItem>;
}) {
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {working ? <span className="text-xs text-white/60">Working</span> : null}
      </header>
      {/* column-reverse keeps the view pinned to the newest reply while the reader is at the bottom. */}
      <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <ol className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
          {items.map((item) => (
            <li key={item.id}>
              <TranscriptItem item={item} />
            </li>
          ))}
        </ol>
      </div>
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-4">
        {messages.length > 0 ? (
          <ul className="flex flex-col gap-1 border-t border-white/10 pt-2 text-xs">
            {messages.map((message) => (
              <li key={message.id} className="flex gap-3">
                <span className="min-w-0 flex-1 truncate text-white/80">{message.text}</span>
                <span className="shrink-0 text-white/50">{STATUS_LABEL[message.status]}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <GuestComposer />
      </div>
    </>
  );
}

function TranscriptItem({ item }: { readonly item: GuestTranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="border-l-2 border-white/30 pl-3 text-sm whitespace-pre-wrap">
          {item.text}
        </div>
      );
    case "assistant":
      return <GuestMarkdown text={item.text} />;
    case "plan":
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-white/50">Plan</span>
          <GuestMarkdown text={item.text} />
        </div>
      );
    case "question":
      return (
        <div className="flex flex-col gap-2 text-sm">
          {item.questions.map((question) => (
            <div key={question.question} className="flex flex-col gap-1">
              <span className="text-xs text-white/50">{question.header || "Question"}</span>
              <p>{question.question}</p>
              {question.options.length > 0 ? (
                <ul className="list-disc pl-5 text-white/70">
                  {question.options.map((option) => (
                    <li key={option}>{option}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      );
    case "tool":
      return <p className="truncate text-xs text-white/40">{item.label}</p>;
  }
}

const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

function GuestMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="chat-markdown min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function GuestComposer() {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || sending) return;
    setSending(true);
    const failure = await postGuest("messages", { text: trimmed });
    setSending(false);
    setError(failure);
    // Keep anything typed while the request was in flight.
    if (failure === null) setText((current) => (current.trim() === trimmed ? "" : current));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label="Message"
        placeholder="Message"
        maxLength={GUEST_MESSAGE_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-3">
        <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
          {error}
        </p>
        <Button type="submit" size="sm" disabled={sending || text.trim() === ""}>
          Send
        </Button>
      </div>
    </form>
  );
}
