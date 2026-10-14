import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ago, cn } from "@/lib/utils";
import type { ThreadEntry } from "@/types";

function who(e: ThreadEntry): string {
  if (e.kind === "note") return "Internal note";
  if (e.kind === "outbound") return "We replied";
  return e.from === "sender" ? "They wrote" : `${e.from} wrote`;
}

function Entry({ entry }: { entry: ThreadEntry }) {
  const fresh = entry.newText || entry.text;
  const hasQuote = entry.text.trim() !== fresh.trim();
  const [showQuote, setShowQuote] = useState(false);
  return (
    <div
      className={cn(
        "rounded-lg px-4 py-3",
        entry.kind === "note" ? "border border-dashed bg-transparent" : "bg-muted/70",
        entry.kind === "outbound" && "bg-transparent ring-1 ring-border",
      )}
    >
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">
        {who(entry)} <span className="font-normal">· {ago(entry.at)}</span>
      </div>
      <div className="max-h-80 overflow-auto text-[15px] leading-relaxed break-words whitespace-pre-wrap">
        {showQuote ? entry.text : fresh || <span className="text-muted-foreground italic">(no text)</span>}
      </div>
      {hasQuote && (
        <Button
          variant="link"
          size="xs"
          className="mt-1 h-auto px-0 text-xs text-muted-foreground"
          onClick={() => setShowQuote(!showQuote)}
        >
          {showQuote ? "Hide quoted text" : "Show quoted text"}
        </Button>
      )}
    </div>
  );
}

/** The latest inbound message, expandable to the whole thread. */
export function Thread({ entries }: { entries: ThreadEntry[] }) {
  const [open, setOpen] = useState(false);
  const latest = [...entries].reverse().find((e) => e.kind === "inbound") ?? entries.at(-1);
  if (!latest) return null;
  return (
    <div className="space-y-2">
      {(open ? entries : [latest]).map((e, i) => (
        <Entry key={`${e.at}-${i}`} entry={e} />
      ))}
      {entries.length > 1 && (
        <Button variant="ghost" size="xs" onClick={() => setOpen(!open)}>
          {open ? "Show the latest message only" : `Show the whole thread (${entries.length})`}
        </Button>
      )}
    </div>
  );
}
