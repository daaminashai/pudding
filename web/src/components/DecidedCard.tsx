import { CircleCheck, Copy, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { JellyLink, SenderLine } from "@/components/DraftMeta";
import { Hint } from "@/components/Hint";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copyReply, safeUrl } from "@/lib/utils";
import type { ApproveResult, Draft } from "@/types";

/** What a card turns into once approved: confirmation, and the reply to paste when it wasn't sent. */
export function DecidedCard({
  draft,
  result,
  copied,
  onDismiss,
}: {
  draft: Draft;
  result: ApproveResult;
  copied: boolean;
  onDismiss: () => void;
}) {
  const [copyLabel, setCopyLabel] = useState(copied ? "Copy again" : "Copy reply");
  const sent = result.status === "sent";
  const headline = sent
    ? result.warning
      ? "Marked as sent"
      : "Sent through Jelly"
    : copied
      ? "Approved and copied. Paste it into the reply box in Jelly."
      : "Approved. Copy the reply and paste it into the reply box in Jelly.";
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base leading-snug font-semibold break-words">{draft.subject || "(no subject)"}</h2>
          <SenderLine draft={draft} />
        </div>
        <Hint label="Hide this card. It's still listed in the Done tab.">
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
            <X />
          </Button>
        </Hint>
      </div>
      <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-muted px-4 py-3 text-sm">
        {result.warning ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        ) : (
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
        )}
        <div className="space-y-1">
          <p className="font-medium">{headline}</p>
          {result.warning && <p className="text-muted-foreground">{result.warning}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {safeUrl(result.url) && (
          <JellyLink url={result.url} className={buttonVariants({ variant: sent ? "outline" : "default" })} />
        )}
        {!sent && (
          <Hint label="Copy the approved reply, to paste into the reply box in Jelly.">
            <Button
              variant="outline"
              onClick={async () => setCopyLabel((await copyReply(result.text)) ? "Copied" : "Couldn't copy")}
            >
              <Copy />
              {copyLabel}
            </Button>
          </Hint>
        )}
      </div>
    </Card>
  );
}
