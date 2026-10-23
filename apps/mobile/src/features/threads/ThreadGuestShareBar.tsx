import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isGuestShareExpired,
  type GuestMessageId,
  type ScopedThreadRef,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_GUEST_SHARE_ATOM = Atom.make<ThreadGuestShare | null>(null);

function guestShareAtom(ref: ScopedThreadRef) {
  let previous: ThreadGuestShare | null = null;
  return Atom.make((get) => {
    const next =
      get(environmentThreadDetails.threadAtom(ref))?.projection.thread.guestShare ?? null;
    // The thread record is replaced on unrelated updates; only share changes matter here.
    if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
    return previous;
  });
}

/**
 * Owner controls for a guest link, above the composer: who the link is for, a way to stop
 * sharing, and the guest messages that wait for Send or Dismiss. Links are created on web.
 */
export function ThreadGuestShareBar(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  const { threadRef } = props;
  const shareAtom = useMemo(
    () => (threadRef === null ? NO_GUEST_SHARE_ATOM : guestShareAtom(threadRef)),
    [threadRef],
  );
  const share = useAtomValue(shareAtom);
  const closeGuestShare = useAtomCommand(threadEnvironment.closeGuestShare, "stop guest sharing");
  const resolveGuestMessage = useAtomCommand(
    threadEnvironment.resolveGuestMessage,
    "resolve guest message",
  );
  // One request at a time: a second tap while the first is in flight would double-send.
  const [busy, setBusy] = useState(false);
  // Checked when the thread opens; an expired link stays listed until the owner stops sharing.
  const [openedAt] = useState(Date.now);
  if (threadRef === null || !share) return null;

  const guestName = share.guestName ?? "Guest";
  const pending = share.messages.filter((message) => message.status === "pending");
  const disabled = busy || !props.canOperateThread;

  const run = async (
    failureTitle: string,
    execute: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (disabled) return;
    setBusy(true);
    const result = await execute();
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
    }
  };
  const resolve = (guestMessageId: GuestMessageId, decision: "send" | "dismiss") =>
    void run(
      decision === "send" ? "Could not send guest message" : "Could not dismiss guest message",
      () =>
        resolveGuestMessage({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            guestMessageId,
            decision,
            creationSource: "mobile",
          },
        }),
    );
  const stopSharing = () =>
    Dialog.confirm({
      title: "Stop sharing?",
      message: "The guest loses access and the link stops working.",
      confirmText: "Stop sharing",
      destructive: true,
      onConfirm: () =>
        void run("Could not stop sharing", () =>
          closeGuestShare({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          }),
        ),
    });

  return (
    <View className="pb-2">
      <View className="flex-row items-center gap-2 px-4">
        <SymbolView name="person.2" size={12} tintColorClassName="accent-foreground-muted" />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {isGuestShareExpired(share, openedAt)
            ? "Guest link expired"
            : share.guestName === null
              ? "Guest link active"
              : `${share.guestName} is a guest`}
        </Text>
        <Button label="Stop sharing" tone="text" disabled={disabled} onPress={stopSharing} />
      </View>
      {pending.map((message) => (
        <View
          key={message.id}
          className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-screen p-3"
        >
          <Text className="text-sm text-foreground">
            <Text className="font-t3-medium">{guestName} (guest): </Text>
            {message.text}
          </Text>
          <View className="flex-row gap-2">
            <Button
              label="Send"
              tone="primary"
              accessibilityLabel={`Send message from ${guestName}`}
              disabled={disabled}
              onPress={() => resolve(message.id, "send")}
            />
            <Button
              label="Dismiss"
              tone="secondary"
              accessibilityLabel={`Dismiss message from ${guestName}`}
              disabled={disabled}
              onPress={() => resolve(message.id, "dismiss")}
            />
          </View>
        </View>
      ))}
    </View>
  );
}
