import { FilterX, LoaderCircle, WandSparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ago } from "@/lib/utils";
import type { Skipped } from "@/types";

function Row({ item, onDrafted }: { item: Skipped; onDrafted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="truncate font-medium">{item.subject || "(no subject)"}</div>
        <div className="text-[13px] text-muted-foreground">
          {item.sender ? `${item.sender} · ` : ""}
          {ago(item.at)}
        </div>
        <div className="text-[13px] break-words text-muted-foreground">{item.reason}</div>
        {error && <div className="text-[13px] text-destructive">{error}</div>}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api.draftAnyway(item.messageId);
            toast("Drafted", { description: "It's in To review now." });
            onDrafted();
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <WandSparkles />}
        {busy ? "Drafting…" : "Draft anyway"}
      </Button>
    </div>
  );
}

export function SkippedList({ items, onDrafted }: { items: Skipped[]; onDrafted: () => void }) {
  if (items.length === 0) {
    return <EmptyState icon={FilterX} title="Nothing skipped" />;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        No draft was written for these: automated mail (auto-replies, bounces, reactions, newsletters) and emails the
        drafter judged don't need an answer.
      </p>
      <Card className="divide-y overflow-hidden">
        {items.map((s) => (
          <Row key={s.messageId} item={s} onDrafted={onDrafted} />
        ))}
      </Card>
    </div>
  );
}
