import { CircleCheck, LoaderCircle, MailCheck, Send, Square, Trash2, TriangleAlert, WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api";
import { FlagBadge, JellyLink } from "@/components/DraftMeta";
import { EmptyState } from "@/components/EmptyState";
import { Hint } from "@/components/Hint";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ago, plural } from "@/lib/utils";
import type { BulkStatus, Draft } from "@/types";

/** "Re: Bela: Haven + Framework 12" → "Bela". */
function personName(d: Draft): string {
  if (d.senderName) return d.senderName;
  const name = d.subject
    .replace(/^\s*((re|aw|sv|rv|antw|vs|r)\s*:\s*)+/i, "")
    .split(":")[0]
    ?.trim();
  return name || d.sender || "(no name)";
}

function duration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

function Row({
  draft,
  checked,
  disabled,
  onCheckedChange,
  onChanged,
}: {
  draft: Draft;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "full" | "discard">(null);
  const message = (draft.thread.findLast((e) => e.kind === "inbound")?.newText ?? draft.question).trim();

  async function run(kind: "full" | "discard") {
    setBusy(kind);
    try {
      if (kind === "full") {
        await api.fullReply(draft.id);
        toast("Full reply drafted", { description: "It's in To review now." });
      } else {
        await api.discard(draft.id);
        toast("Discarded", { description: draft.subject });
      }
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="flex gap-3 px-5 py-4">
      <Checkbox
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        aria-label={`Include ${personName(draft)}`}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
          <span className="font-medium">{personName(draft)}</span>
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          <span className="text-muted-foreground" title={draft.receivedAt}>
            {ago(draft.receivedAt)}
          </span>
          {draft.conversationUrl && (
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
          )}
          <JellyLink url={draft.conversationUrl} />
        </div>
        <p className="line-clamp-3 text-[15px] break-words whitespace-pre-wrap">{message || "(no text)"}</p>
        {draft.note && <p className="text-[13px] text-muted-foreground">{draft.note}</p>}
        {draft.flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {draft.flags.map((f) => (
              <FlagBadge key={f.kind} flag={f} />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-start">
        <Hint label="This one needs a real answer: have the AI write a full reply from the docs and move it to To review.">
          <Button variant="ghost" size="xs" disabled={disabled || busy !== null} onClick={() => void run("full")}>
            {busy === "full" ? <LoaderCircle className="animate-spin" /> : <WandSparkles />}
            <span className="hidden sm:inline">Full reply</span>
          </Button>
        </Hint>
        <Hint label="Drop this one without sending anything. It stays unanswered in Jelly.">
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled || busy !== null}
            onClick={() => void run("discard")}
            aria-label="Discard"
          >
            {busy === "discard" ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          </Button>
        </Hint>
      </div>
    </div>
  );
}

function BulkProgress({ bulk, onDismiss }: { bulk: BulkStatus; onDismiss: () => void }) {
  const [stopping, setStopping] = useState(false);
  if (bulk.running) {
    return (
      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <LoaderCircle className="size-4 animate-spin" />
            Sending {Math.min(bulk.processed + 1, bulk.total)} of {bulk.total}…
          </div>
          <Hint label="Stop after the reply that's going out right now. The rest stay here, unsent.">
            <Button
              variant="outline"
              size="sm"
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                await api.stopConfirmations().catch((e) => toast.error((e as Error).message));
              }}
            >
              <Square />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </Hint>
        </div>
        <Progress value={(bulk.processed / bulk.total) * 100} />
        <p className="text-[13px] text-muted-foreground">
          {plural(bulk.sent, "reply", "replies")} sent so far. They go out one at a time so Jelly doesn't rate-limit us;
          you can leave this page open or come back.
        </p>
      </Card>
    );
  }
  const problem = bulk.stoppedReason || bulk.failed.length > 0;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 text-sm">
          {problem ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CircleCheck className="mt-0.5 size-4 shrink-0" />
          )}
          <div className="space-y-1">
            <p className="font-medium">
              Sent {bulk.sent} of {plural(bulk.total, "confirmation")}.
            </p>
            {bulk.stoppedReason && <p className="text-muted-foreground">{bulk.stoppedReason}</p>}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {bulk.failed.length > 0 && (
        <ul className="space-y-1 border-t pt-3 text-[13px] text-muted-foreground">
          {bulk.failed.map((f) => (
            <li key={f.id} className="break-words">
              <span className="font-medium text-foreground">{f.subject}</span>: {f.error}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ConfirmationsPanel({
  confirmations,
  bulk,
  gapSeconds,
  sendingUnavailable,
  onChanged,
}: {
  confirmations: Draft[];
  bulk: BulkStatus | null;
  gapSeconds: number;
  sendingUnavailable: string | null;
  onChanged: () => void;
}) {
  // Everything without a flag starts selected; flagged ones (assigned, attachments) need a look first.
  const [overrides, setOverrides] = useState<Map<number, boolean>>(new Map());
  const [confirming, setConfirming] = useState(false);
  // Fixed when the dialog opens, so its text doesn't change as the list updates behind it.
  const [toSend, setToSend] = useState<Draft[]>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const isSelected = (d: Draft) => overrides.get(d.id) ?? d.flags.length === 0;
  const selected = useMemo(() => confirmations.filter(isSelected), [confirmations, overrides]);
  const running = bulk?.running ?? false;
  const all = selected.length === confirmations.length;
  const reply = confirmations[0]?.draft ?? "";
  const showBulk = bulk && (bulk.running || bulk.startedAt !== dismissed);

  async function send() {
    try {
      await api.sendConfirmations(toSend.map((d) => d.id));
      setOverrides(new Map());
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      {showBulk && <BulkProgress bulk={bulk} onDismiss={() => setDismissed(bulk.startedAt)} />}

      {confirmations.length === 0 ? (
        !running && (
          <EmptyState icon={MailCheck} title="No confirmations waiting">
            Replies to the sign-up confirmation email that only share a favorite food show up here, ready to send in one
            go.
          </EmptyState>
        )
      ) : (
        <>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Replies to the sign-up confirmation email that only share a favorite food. Each one gets this reply:
            </p>
            <div className="rounded-lg border bg-card px-4 py-3 text-[15px] whitespace-pre-wrap">{reply}</div>
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-5 py-3">
              <label className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={all ? true : selected.length === 0 ? false : "indeterminate"}
                  disabled={running}
                  onCheckedChange={() => setOverrides(new Map(confirmations.map((d) => [d.id, !all] as const)))}
                  aria-label="Select all"
                />
                <span className="text-muted-foreground tabular-nums">
                  {selected.length} of {confirmations.length} selected
                </span>
              </label>
              <div className="flex-1" />
              {sendingUnavailable ? (
                <span className="text-[13px] text-muted-foreground">
                  Sending through Jelly is off, so these can't be sent in bulk.
                </span>
              ) : (
                <Hint
                  label={`Send the reply above to everyone selected, one at a time, ${plural(gapSeconds, "second")} apart so Jelly doesn't rate-limit us. Each conversation is archived. You'll be asked to confirm first.`}
                >
                  <Button
                    size="sm"
                    disabled={running || selected.length === 0}
                    onClick={() => {
                      setToSend(selected);
                      setConfirming(true);
                    }}
                  >
                    <Send />
                    Send {plural(selected.length, "confirmation")}
                  </Button>
                </Hint>
              )}
            </div>
            <div className="divide-y">
              {confirmations.map((d) => (
                <Row
                  key={d.id}
                  draft={d}
                  checked={isSelected(d)}
                  disabled={running}
                  onCheckedChange={(v) => setOverrides((m) => new Map(m).set(d.id, v))}
                  onChanged={onChanged}
                />
              ))}
            </div>
          </Card>
        </>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send {plural(toSend.length, "confirmation reply", "confirmation replies")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They go out from the shared inbox in Jelly one at a time, {plural(gapSeconds, "second")} apart (
              {duration(toSend.length * gapSeconds)}), and each conversation is archived. You can stop part way, but
              replies can't be unsent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap">{reply}</div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send()}>
              <Send />
              Send {toSend.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
