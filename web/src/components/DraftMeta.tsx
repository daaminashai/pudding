import {
  ArrowUpRight,
  Bot,
  Hand,
  MessagesSquare,
  Paperclip,
  ShieldAlert,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Hint } from "@/components/Hint";
import { Badge } from "@/components/ui/badge";
import { ago, safeUrl } from "@/lib/utils";
import type { Draft, Flag } from "@/types";

type Tone = "default" | "outline" | "muted";

export const FLAGS: Record<string, { label: string; icon: LucideIcon; tone: Tone; hint: string }> = {
  unverified: {
    label: "Check the facts",
    icon: ShieldAlert,
    tone: "default",
    hint: "The reply has a link, number, date or email address that isn't in the docs, past replies or the thread. Make sure it's right before approving.",
  },
  ai_style: {
    label: "Sounds AI-written",
    icon: Bot,
    tone: "outline",
    hint: 'Em dashes, markdown or stock phrases like "Feel free to reach out" are still in the reply. Worth a quick edit.',
  },
  assigned: {
    label: "Assigned",
    icon: UserRound,
    tone: "outline",
    hint: "Someone on the team is assigned to this conversation in Jelly. Check they aren't already handling it.",
  },
  attachments: {
    label: "Has attachments",
    icon: Paperclip,
    tone: "outline",
    hint: "They attached files the AI couldn't see. Open it in Jelly to look at them.",
  },
  long_thread: {
    label: "Long thread",
    icon: MessagesSquare,
    tone: "muted",
    hint: "Lots of back-and-forth. Read the whole thread before approving.",
  },
  unknown_sender: {
    label: "Unknown sender",
    icon: UserRound,
    tone: "muted",
    hint: "Pudding couldn't tell who sent this.",
  },
};

export function senderLabel(d: Pick<Draft, "sender" | "senderName">): string | null {
  return d.senderName && d.sender ? `${d.senderName} <${d.sender}>` : d.sender || d.senderName;
}

export function JellyLink({ url, className }: { url: string | null; className?: string }) {
  const href = safeUrl(url);
  if (!href) return null;
  return (
    <Hint label="Open this conversation in Jelly in a new tab.">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className ?? "inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline"}
      >
        Open in Jelly
        <ArrowUpRight className="size-3.5" />
      </a>
    </Hint>
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
    <Hint label="How likely the AI thinks this reply can be sent without changes.">
      <Badge variant={variant} className="tabular-nums" tabIndex={0}>
        {pct}% confident
      </Badge>
    </Hint>
  );
}

export function FlagBadge({ flag }: { flag: Flag }) {
  const meta = FLAGS[flag.kind] ?? { label: flag.kind, icon: ShieldAlert, tone: "muted" as Tone, hint: flag.detail };
  const Icon = meta.icon;
  return (
    <Hint label={meta.hint}>
      <Badge variant={meta.tone} tabIndex={0}>
        <Icon />
        {meta.label}
      </Badge>
    </Hint>
  );
}

export function NeedsHumanBadge() {
  return (
    <Hint label="The AI isn't sure about this one: the docs don't cover it, or it's sensitive (a complaint, money, safety, an upset sender). Its note below says why.">
      <Badge variant="default" tabIndex={0}>
        <Hand />
        Needs a careful look
      </Badge>
    </Hint>
  );
}
