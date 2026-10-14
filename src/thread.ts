import type { Comment, ConversationDetail, Message } from "./marmalade.js";
import { extractSender } from "./metadata.js";

export interface ThreadEntry {
  /** "note" is an internal comment from a teammate; never shown to the sender. */
  kind: "inbound" | "outbound" | "note";
  from: string;
  at: string;
  /** Full text, quoted history included: the model needs it for context. */
  text: string;
  /** Just what this message added, for showing in the dashboard. */
  newText?: string;
}

export interface Thread {
  subject: string;
  entries: ThreadEntry[];
}

export function messageTime(message: Message): number {
  const t = Date.parse(message.sentAt ?? message.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Oldest first. */
export function sortedMessages(conversation: ConversationDetail): Message[] {
  return [...conversation.messages].sort((a, b) => messageTime(a) - messageTime(b));
}

export function latestMessage(conversation: ConversationDetail): Message | undefined {
  return sortedMessages(conversation).at(-1);
}

export function messageText(message: Message): string {
  if (message.content && message.content.trim() !== "") return message.content.trim();
  if (message.contentHtml) return htmlToText(message.contentHtml);
  return "";
}

/** Messages and internal comments, oldest first. */
export function toThread(conversation: ConversationDetail): Thread {
  const messages: Array<ThreadEntry & { t: number }> = conversation.messages.map((m) => ({
    kind: m.isInbound ? "inbound" : "outbound",
    from: extractSender(m).from ?? (m.isInbound ? "sender" : "us"),
    at: m.sentAt ?? m.createdAt,
    text: messageText(m),
    t: messageTime(m),
  }));
  const notes = conversation.comments.map((c: Comment) => ({
    kind: "note" as const,
    from: "teammate",
    at: c.createdAt,
    text: (c.body ?? "").trim(),
    t: Date.parse(c.createdAt) || 0,
  }));
  const entries = [...messages, ...notes]
    .filter((e) => e.text !== "")
    .sort((a, b) => a.t - b.t)
    .map(({ t: _t, ...entry }) => ({ ...entry, newText: stripQuoted(entry.text) }));
  return { subject: conversation.subject ?? "", entries };
}

// Lines that start the quoted history most clients append below a reply.
const QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s.+/,
  /^_{10,}\s*$/,
];

/** "On <date>, <name> <email> wrote:", which Gmail often wraps over two or three lines. */
function isAttribution(lines: string[], i: number): boolean {
  if (!/^On\s/.test(lines[i]!.trim())) return false;
  const joined = lines
    .slice(i, i + 3)
    .map((l) => l.trim())
    .join(" ");
  return /^On\s.{4,300}?\bwrote:/.test(joined);
}

const FORWARDED = /^-{2,}\s*Forwarded message\s*-{2,}/i;

/**
 * Drops quoted history ("On … wrote:", "> …") so only the new text is left. A
 * forward with nothing written above it is the message itself, so it's kept.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FORWARDED.test(line.trim()) && out.join("").trim() === "") return text.trim();
    if (isAttribution(lines, i) || QUOTE_MARKERS.some((re) => re.test(line.trim()))) break;
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

const EMAIL_LINE = /^[\w.+'-]+@[\w-]+(\.[\w-]+)+(\s*\(mailto:[^)]*\))?$/;
// "C: +1 (949) 555-0100"
const PHONE_LINE = /^(c|t|m|p|ph|phone|cell|mobile|tel)\s*[:.]\s*\+?[\d\s().-]{7,}$/i;
// "Hack Club (https://hackclub.com/) is an open source … 501(c)(3) nonprofit."
const FOOTER_LINE = /^hack club\b.*\b(open source|nonprofit|501\(c\)\(3\))/i;
/** A closing on its own line: "Cheers", "Sincerely,", "Kind regards"… */
export const CLOSING_LINE =
  /^(cheers|best|best wishes|all the best|(kind |warm |best )?regards|warmly|sincerely|thanks|thank you|thanks again|many thanks)[\s,.!]*$/i;

/**
 * Drops the sign-off from one of our replies: from a closing line ("Sincerely,"),
 * or from the name and title lines above an email address, phone number or the
 * Hack Club footer, to the end. Jelly appends each sender's signature itself, so
 * examples shouldn't teach one. A reply that was only a signature comes back empty.
 */
export function stripSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  const closing = lines.findIndex((l, i) => i > 0 && CLOSING_LINE.test(l.trim()));
  let cut = lines.findIndex((l, i) => {
    const line = l.trim();
    return i > 0 && (l === "-- " || EMAIL_LINE.test(line) || PHONE_LINE.test(line) || FOOTER_LINE.test(line));
  });
  if (cut !== -1 && lines[cut] !== "-- ") {
    let kept = 0;
    for (let i = cut - 1; i >= 0 && kept < 3; i--) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      if (line.length > 60 || /[.?!:]$/.test(line)) break;
      cut = i;
      kept++;
    }
  }
  const end = Math.min(...[closing, cut, lines.length].filter((n) => n !== -1));
  return lines.slice(0, end).join("\n").trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, (q) => q.replace(/^/gm, "> "))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
