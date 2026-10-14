import { Send, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api";
import { BulkProgress } from "@/components/BulkProgress";
import { senderLabel } from "@/components/DraftMeta";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { duration, plural } from "@/lib/utils";
import type { BulkStatus, Draft } from "@/types";

interface Props {
  /** Pending drafts that can be selected (not waiting in a bulk send). */
  drafts: Draft[];
  selected: Set<number>;
  onSelectedChange: (selected: Set<number>) => void;
  /** The reply as it stands in each card's box. */
  textOf: (draft: Draft) => string;
  bulk: BulkStatus | null;
  gapSeconds: number;
  sendingUnavailable: string | null;
  onChanged: () => void;
}

/** Select drafts in To review, then send or discard them all at once. */
export function ReviewToolbar({
  drafts,
  selected,
  onSelectedChange,
  textOf,
  bulk,
  gapSeconds,
  sendingUnavailable,
  onChanged,
}: Props) {
  const [confirm, setConfirm] = useState<null | "send" | "discard">(null);
  // Fixed when a dialog opens, so its text doesn't change as the list updates behind it.
  const [chosen, setChosen] = useState<Array<{ draft: Draft; text: string }>>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const picked = drafts.filter((d) => selected.has(d.id));
  const n = picked.length;
  const all = n > 0 && n === drafts.length;
  const sending = bulk?.running ?? false;
  const showBulk = bulk?.kind === "reply" && (bulk.running || bulk.startedAt !== dismissed);
  const flagged = chosen.filter(({ draft }) => draft.needsHuman || draft.flags.length > 0).length;

  function open(kind: "send" | "discard") {
    const items = picked.map((d) => ({ draft: d, text: textOf(d).trim() }));
    const empty = items.find((i) => !i.text);
    if (kind === "send" && empty) {
      toast.error(`The reply to “${empty.draft.subject || "(no subject)"}” is empty.`);
      return;
    }
    setChosen(items);
    setConfirm(kind);
  }

  async function send() {
    try {
      await api.sendDrafts(chosen.map(({ draft, text }) => ({ id: draft.id, text })));
      onSelectedChange(new Set());
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function discard() {
    try {
      const result = await api.discardDrafts(chosen.map(({ draft }) => draft.id));
      if (result.discarded > 0) toast(`Discarded ${plural(result.discarded, "draft")}`);
      if (result.failed.length > 0) {
        toast.error(`${plural(result.failed.length, "draft")} couldn't be discarded`, {
          description: result.failed[0]!.error,
        });
      }
      onSelectedChange(new Set());
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      {showBulk && <BulkProgress bulk={bulk} onDismiss={() => setDismissed(bulk.startedAt)} />}

      {drafts.length > 0 && (
        <div className="sticky top-[57px] z-30 -mt-2 bg-background/85 pt-2 backdrop-blur-md">
          <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-5 py-2 shadow-xs">
            <label className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={all ? true : n === 0 ? false : "indeterminate"}
                onCheckedChange={() => onSelectedChange(all ? new Set() : new Set(drafts.map((d) => d.id)))}
                aria-label="Select all"
              />
              <span className="text-muted-foreground tabular-nums">
                {n === 0 ? "Select all" : `${n} of ${drafts.length} selected`}
              </span>
            </label>
            <div className="flex-1" />
            {n === 0 ? (
              <span className="hidden text-[13px] text-muted-foreground sm:inline">
                Tick drafts to send or discard several at once.
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => onSelectedChange(new Set())}>
                  Clear
                </Button>
                <Hint label="Throw the selected drafts away without sending anything. You'll be asked to confirm first.">
                  <Button variant="outline" size="sm" onClick={() => open("discard")}>
                    <Trash2 />
                    Discard {n}
                  </Button>
                </Hint>
                {sendingUnavailable ? (
                  <span className="text-[13px] text-muted-foreground">Sending through Jelly is off.</span>
                ) : sending ? (
                  <span className="text-[13px] text-muted-foreground">Another bulk send is running.</span>
                ) : (
                  <Hint
                    label={`Send each selected reply as it is in its box, one at a time, ${plural(gapSeconds, "second")} apart so Jelly doesn't rate-limit us. Each conversation is archived. You'll be asked to confirm first.`}
                  >
                    <Button size="sm" onClick={() => open("send")}>
                      <Send />
                      Send {n}
                    </Button>
                  </Hint>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={confirm === "send"} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Send {plural(chosen.length, "reply", "replies")}?</AlertDialogTitle>
            <AlertDialogDescription>
              Each goes to its sender from the shared inbox in Jelly, one at a time, {plural(gapSeconds, "second")} apart
              ({duration(chosen.length * gapSeconds)}), and each conversation is archived. You can stop part way, but
              replies can't be unsent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {flagged > 0 && (
            <p className="flex gap-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                {plural(flagged, "of these is", "of these are")} flagged or marked for a careful look. Make sure you've
                read {flagged === 1 ? "it" : "them"}.
              </span>
            </p>
          )}
          <ul className="-mx-6 max-h-[45vh] divide-y overflow-y-auto border-y">
            {chosen.map(({ draft, text }) => (
              <li key={draft.id} className="space-y-1 px-6 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium break-words">{draft.subject || "(no subject)"}</p>
                  <div className="flex shrink-0 gap-1">
                    {text !== draft.draft.trim() && <Badge variant="muted">Edited</Badge>}
                    {(draft.needsHuman || draft.flags.length > 0) && (
                      <Badge variant="default">
                        <TriangleAlert />
                        Flagged
                      </Badge>
                    )}
                  </div>
                </div>
                <p className="truncate text-[13px] text-muted-foreground">To {senderLabel(draft) ?? "the sender"}</p>
                <p className="line-clamp-3 text-[13px] break-words whitespace-pre-wrap">{text}</p>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send()}>
              <Send />
              Send {chosen.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "discard"} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard {plural(chosen.length, "draft")}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing is sent. The emails stay unanswered in Jelly, and Pudding won't draft them again unless they write
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="-mx-6 max-h-[40vh] divide-y overflow-y-auto border-y">
            {chosen.map(({ draft }) => (
              <li key={draft.id} className="px-6 py-2.5">
                <p className="text-sm font-medium break-words">{draft.subject || "(no subject)"}</p>
                <p className="truncate text-[13px] text-muted-foreground">{senderLabel(draft) ?? "Unknown sender"}</p>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction onClick={() => void discard()}>
              <Trash2 />
              Discard {chosen.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
