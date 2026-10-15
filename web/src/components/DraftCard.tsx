import { Clock, LoaderCircle, Send, Sparkles, Trash2, WandSparkles, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api";
import { ConfidenceBadge, FlagBadge, NeedsHumanBadge, SenderLine, senderLabel } from "@/components/DraftMeta";
import { Hint } from "@/components/Hint";
import { Thread } from "@/components/Thread";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, copyReply } from "@/lib/utils";
import type { ApproveResult, Draft } from "@/types";

type Busy = null | "sending" | "rewriting" | "discarding";

interface Props {
  draft: Draft;
  /** Null when approving sends through Jelly; otherwise approving copies the reply. */
  sendingUnavailable: string | null;
  /** Ticked for a bulk action from the toolbar above the list. */
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  /** Part of a bulk send that's running: waiting its turn, or going out now. Locks the card. */
  bulk: null | "queued" | "sending";
  /** The reply as it stands in the box, so a bulk send sends what's shown here. */
  onTextChange: (id: number, text: string) => void;
  onApproved: (draft: Draft, result: ApproveResult, copied: boolean) => void;
  onChanged: () => void;
}

export function DraftCard({
  draft,
  sendingUnavailable,
  selected,
  onSelectedChange,
  bulk,
  onTextChange,
  onApproved,
  onChanged,
}: Props) {
  const [text, setText] = useState(draft.draft);
  const serverText = useRef(draft.draft);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const instructionsRef = useRef<HTMLInputElement>(null);
  const sends = sendingUnavailable === null;

  // A new version from the server replaces the text, unless it's been edited here.
  useEffect(() => {
    if (draft.draft === serverText.current) return;
    setText((current) => (current === serverText.current ? draft.draft : current));
    serverText.current = draft.draft;
  }, [draft.draft]);

  useEffect(() => {
    onTextChange(draft.id, text);
  }, [draft.id, text, onTextChange]);

  const edited = text !== draft.draft;

  async function approve() {
    setError("");
    setBusy("sending");
    try {
      const result = await api.approve(draft.id, text);
      const copied = result.status === "approved" ? await copyReply(result.text) : false;
      onApproved(draft, result, copied);
    } catch (e) {
      setError((e as Error).message);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function rewrite() {
    setError("");
    setBusy("rewriting");
    try {
      const updated = await api.rewrite(draft.id, text, instructions.trim());
      serverText.current = updated.draft;
      setText(updated.draft);
      setInstructions("");
      setRewriteOpen(false);
      toast("Draft rewritten");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    setError("");
    setBusy("discarding");
    try {
      await api.discard(draft.id);
      toast("Draft discarded", { description: draft.subject || undefined });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  const disabled = busy !== null || bulk !== null;
  return (
    <Card className={cn("overflow-hidden transition-shadow", selected && "ring-2 ring-ring")}>
      <div className="space-y-4 p-5">
        <header className="flex items-start gap-3">
          <Checkbox
            className="mt-1"
            checked={selected}
            disabled={disabled}
            onCheckedChange={(v) => onSelectedChange(v === true)}
            aria-label={`Select “${draft.subject || "(no subject)"}”`}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base leading-snug font-semibold break-words">{draft.subject || "(no subject)"}</h2>
              <ConfidenceBadge confidence={draft.confidence} />
            </div>
            <SenderLine draft={draft} />
          </div>
        </header>

        {(draft.needsHuman || draft.flags.length > 0) && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {draft.needsHuman && <NeedsHumanBadge />}
              {draft.flags.map((f) => (
                <FlagBadge key={f.kind} flag={f} />
              ))}
            </div>
            {draft.flags.length > 0 && (
              <ul className="space-y-0.5 text-[13px] text-muted-foreground">
                {draft.flags.map((f) => (
                  <li key={f.kind} className="break-words">
                    {f.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {draft.note && (
          <p className="flex gap-2 text-[13px] text-muted-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{draft.note}</span>
          </p>
        )}

        <Thread entries={draft.thread} />

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <label htmlFor={`reply-${draft.id}`} className="font-medium">
              Reply
            </label>
            {edited && <span>Edited</span>}
          </div>
          <Textarea
            id={`reply-${draft.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled}
            spellCheck
            className="max-h-[32rem] min-h-28"
          />
        </div>

        {rewriteOpen && (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void rewrite();
            }}
          >
            <Input
              ref={instructionsRef}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRewriteOpen(false)}
              placeholder="What should change? e.g. shorter, mention the deadline (optional)"
              disabled={disabled}
              autoFocus
            />
            <Hint label="Write a new draft with these instructions. Leave the box empty for a fresh attempt.">
              <Button type="submit" variant="secondary" disabled={disabled}>
                {busy === "rewriting" ? <LoaderCircle className="animate-spin" /> : <WandSparkles />}
                {busy === "rewriting" ? "Rewriting…" : "Rewrite"}
              </Button>
            </Hint>
          </form>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-5 py-3">
        <Hint
          label={
            sends
              ? "Send this reply to them through Jelly, from the shared inbox, and archive the conversation. You'll be asked to confirm first."
              : "Mark this reply approved and copy it, so you can paste it into the conversation in Jelly yourself. Nothing is sent."
          }
        >
          <Button disabled={disabled || !text.trim()} onClick={() => (sends ? setConfirmSend(true) : void approve())}>
            {busy === "sending" ? <LoaderCircle className="animate-spin" /> : sends ? <Send /> : <Copy />}
            {busy === "sending" ? (sends ? "Sending…" : "Approving…") : sends ? "Approve & send" : "Approve & copy"}
          </Button>
        </Hint>
        <Hint label="Have the AI write this draft again. You can tell it what to change, like “shorter” or “mention the deadline”. Your edits in the box are its starting point.">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setRewriteOpen(!rewriteOpen);
              if (!rewriteOpen) setTimeout(() => instructionsRef.current?.focus());
            }}
          >
            <WandSparkles />
            Rewrite
          </Button>
        </Hint>
        <Hint label="Throw this draft away without sending anything. The email stays unanswered in Jelly, and Pudding won't draft it again unless they write back.">
          <Button variant="ghost" disabled={disabled} onClick={() => setConfirmDiscard(true)}>
            {busy === "discarding" ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Discard
          </Button>
        </Hint>
        {bulk && (
          <span className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
            {bulk === "sending" ? <LoaderCircle className="size-4 animate-spin" /> : <Clock className="size-4" />}
            {bulk === "sending" ? "Sending…" : "Waiting to send"}
          </span>
        )}
      </footer>

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this reply now?</AlertDialogTitle>
            <AlertDialogDescription>
              It goes to {senderLabel(draft) ?? "the sender"} from the shared inbox in Jelly, and the conversation is
              archived. It can't be unsent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-56 overflow-auto rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap">{text}</div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void approve()}>
              <Send />
              Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing is sent. The email stays unanswered in Jelly, and Pudding won't draft it again unless they write
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void discard()}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
