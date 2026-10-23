import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { GuestMessageId, ScopedThreadRef, ThreadGuestShare } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, UserIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import { guestShareDialogThreadAtom } from "./guestShareDialogState";

function useThreadGuestShare(threadRef: ScopedThreadRef | null): ThreadGuestShare | null {
  return useQuietThreadProjection(threadRef)?.projection.thread.guestShare ?? null;
}

export function GuestShareDialogHost() {
  const threadRef = useAtomValue(guestShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <GuestShareDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(guestShareDialogThreadAtom, null)}
    />
  );
}

type CreateState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "created"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

function GuestShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const activeShare = useThreadGuestShare(threadRef);
  const canCreate = useAtomValue(
    serverEnvironment.createGuestShare.permissionAtom(threadRef.environmentId),
  );
  const createGuestShare = useAtomCommand(serverEnvironment.createGuestShare, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "guest link" });
  const [state, setState] = useState<CreateState>({ status: "idle" });

  const create = async () => {
    setState({ status: "creating" });
    const result = await createGuestShare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success") {
      setState({ status: "created", url: result.value.url });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Could not create a guest link.",
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "creating") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share with guest</DialogTitle>
          <DialogDescription>
            The guest sees messages and the agent's replies, not tool output. Replies can still
            repeat what the agent read.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.status === "created" ? (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Guest link"
                value={state.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(state.url)}>
                {isCopied ? <CheckIcon /> : <CopyIcon />}
                {isCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {activeShare !== null
                ? "A new link ends the current one."
                : "The link works once and expires in 24 hours."}
            </p>
          )}
          {state.status === "failed" ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {state.status === "created" ? (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={state.status === "creating"}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void create()}
                disabled={!canCreate || state.status === "creating"}
              >
                {state.status === "creating" ? "Creating..." : "Create link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Header status for a shared thread, with the way to end the share. */
export function GuestShareIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const share = useThreadGuestShare(threadRef);
  const closeGuestShare = useOrchestrationCommand(threadEnvironment.closeGuestShare, {
    label: "stop guest share",
  });
  const [closing, setClosing] = useState(false);
  if (share === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      <UserIcon aria-hidden className="size-3.5" />
      <GuestShareStatus share={share} />
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={closing}
        onClick={async () => {
          setClosing(true);
          await closeGuestShare({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          });
          setClosing(false);
        }}
      >
        Stop sharing
      </Button>
    </div>
  );
}

function GuestShareStatus({ share }: { readonly share: ThreadGuestShare }) {
  const nowMinute = useNowMinute();
  // The share stays on the thread after it expires, until the owner clears it.
  if (share.expiresAt.slice(0, 16) <= nowMinute) return <span>Guest link expired</span>;
  return (
    <span>{share.guestName !== null ? `${share.guestName} is a guest` : "Guest link active"}</span>
  );
}

/** Guest messages wait here until the owner sends or dismisses each one. */
export function GuestMessagesBar({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const share = useThreadGuestShare(threadRef);
  const resolveGuestMessage = useOrchestrationCommand(threadEnvironment.resolveGuestMessage, {
    label: "resolve guest message",
  });
  const [busyId, setBusyId] = useState<GuestMessageId | null>(null);
  const pending = share?.messages.filter((message) => message.status === "pending") ?? [];
  if (share === null || pending.length === 0) return null;
  const guestName = share.guestName ?? "Guest";

  const resolve = async (guestMessageId: GuestMessageId, decision: "send" | "dismiss") => {
    setBusyId(guestMessageId);
    await resolveGuestMessage({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, guestMessageId, decision },
    });
    setBusyId(null);
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${pending.length} guest message${pending.length === 1 ? "" : "s"}`}
        aria-live="polite"
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        <ComposerBanner.Children render={<ol />}>
          {pending.map((message) => (
            <ComposerBanner.Row render={<li />} key={message.id}>
              <ComposerBanner.Icon>
                <UserIcon />
              </ComposerBanner.Icon>
              <ComposerBanner.Content className="text-foreground/80">
                <span className="shrink-0 text-muted-foreground">{guestName} (guest):</span>
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                    {message.text}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-96 break-words whitespace-pre-wrap">
                    {message.text}
                  </TooltipPopup>
                </Tooltip>
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busyId !== null}
                  onClick={() => void resolve(message.id, "dismiss")}
                >
                  Dismiss
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void resolve(message.id, "send")}
                >
                  Send
                </Button>
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          ))}
        </ComposerBanner.Children>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
