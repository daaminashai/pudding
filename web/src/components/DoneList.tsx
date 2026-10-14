import { ChevronRight, CircleCheck, Copy } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { JellyLink } from "@/components/DraftMeta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ago, copyText } from "@/lib/utils";
import type { Draft } from "@/types";

const STATUS: Record<string, { label: string; variant: "default" | "outline" | "muted" }> = {
  sent: { label: "Sent", variant: "default" },
  approved: { label: "Approved", variant: "outline" },
  discarded: { label: "Discarded", variant: "muted" },
  stale: { label: "Out of date", variant: "muted" },
};

function Row({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState(false);
  const status = STATUS[draft.status] ?? { label: draft.status, variant: "muted" as const };
  return (
    <div className="space-y-1.5 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="truncate font-medium">{draft.subject || "(no subject)"}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={draft.updatedAt}>
          {ago(draft.updatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
        {draft.statusReason && <span>{draft.statusReason}</span>}
        {draft.sender && <span>· {draft.sender}</span>}
        {draft.conversationUrl && <span aria-hidden>·</span>}
        <JellyLink url={draft.conversationUrl} />
      </div>
      {draft.finalText && (
        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] text-muted-foreground select-none hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            Reply
          </summary>
          <div className="mt-2 rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap">{draft.finalText}</div>
          <Button
            variant="ghost"
            size="xs"
            className="mt-1"
            onClick={async () => setCopied(await copyText(draft.finalText!))}
          >
            <Copy />
            {copied ? "Copied" : "Copy"}
          </Button>
        </details>
      )}
    </div>
  );
}

export function DoneList({ drafts }: { drafts: Draft[] }) {
  if (drafts.length === 0) {
    return (
      <EmptyState icon={CircleCheck} title="Nothing here yet">
        Drafts you approve, send or discard show up here.
      </EmptyState>
    );
  }
  return (
    <Card className="divide-y overflow-hidden">
      {drafts.map((d) => (
        <Row key={d.id} draft={d} />
      ))}
    </Card>
  );
}
