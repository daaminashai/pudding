import { ArrowUpRight, Bot, Hand, MessagesSquare, Paperclip, ShieldAlert, UserRound, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ago, safeUrl } from "@/lib/utils";
import type { Draft, Flag } from "@/types";

type Tone = "default" | "outline" | "muted";

export const FLAGS: Record<string, { label: string; icon: LucideIcon; tone: Tone }> = {
  unverified: { label: "Check the facts", icon: ShieldAlert, tone: "default" },
  ai_style: { label: "Sounds AI-written", icon: Bot, tone: "outline" },
  assigned: { label: "Assigned", icon: UserRound, tone: "outline" },
  attachments: { label: "Has attachments", icon: Paperclip, tone: "outline" },
  long_thread: { label: "Long thread", icon: MessagesSquare, tone: "muted" },
  unknown_sender: { label: "Unknown sender", icon: UserRound, tone: "muted" },
};

export function senderLabel(d: Pick<Draft, "sender" | "senderName">): string | null {
  return d.senderName && d.sender ? `${d.senderName} <${d.sender}>` : d.sender || d.senderName;
}

export function JellyLink({ url, className }: { url: string | null; className?: string }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline"}
    >
      Open in Jelly
      <ArrowUpRight className="size-3.5" />
    </a>
  );
}

export function SenderLine({ draft }: { draft: Draft }) {
  const who = senderLabel(draft);
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
      {who && <span className="truncate">{who}</span>}
      {who && <span aria-hidden>·</span>}
      <span title={draft.receivedAt}>{ago(draft.receivedAt)}</span>
      {safeUrl(draft.conversationUrl) && <span aria-hidden>·</span>}
      <JellyLink url={draft.conversationUrl} />
    </div>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const variant: Tone = confidence >= 0.8 ? "outline" : confidence >= 0.5 ? "muted" : "default";
  return (
    <Badge variant={variant} className="tabular-nums">
      {pct}% confident
    </Badge>
  );
}

export function FlagBadge({ flag }: { flag: Flag }) {
  const meta = FLAGS[flag.kind] ?? { label: flag.kind, icon: ShieldAlert, tone: "muted" as Tone };
  const Icon = meta.icon;
  return (
    <Badge variant={meta.tone}>
      <Icon />
      {meta.label}
    </Badge>
  );
}

export function NeedsHumanBadge() {
  return (
    <Badge variant="default">
      <Hand />
      Needs a careful look
    </Badge>
  );
}
