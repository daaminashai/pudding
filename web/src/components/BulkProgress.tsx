import { CircleCheck, LoaderCircle, Square, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api";
import { Hint } from "@/components/Hint";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { plural } from "@/lib/utils";
import type { BulkStatus } from "@/types";

/** How a bulk send is going, then how it went (until dismissed). Shared by Confirmations and To review. */
export function BulkProgress({ bulk, onDismiss }: { bulk: BulkStatus; onDismiss: () => void }) {
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
                await api.stopBulk().catch((e) => toast.error((e as Error).message));
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
              Sent {bulk.sent} of{" "}
              {bulk.kind === "confirmation" ? plural(bulk.total, "confirmation") : plural(bulk.total, "reply", "replies")}.
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
