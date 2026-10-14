// Fixture conversations shaped like Marmalade's GET /mailboxes/{id}/conversations/{id}
// response. The metadata shape ({ headers, from }) is a guess until a real payload
// has been inspected; the metadata tests cover the other shapes we accept.
import type { ConversationDetail, Message } from "../src/marmalade.js";

let seq = 0;

export interface MessageOptions {
  id?: string;
  inbound?: boolean;
  from?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: number;
  minutesAgo?: number;
  metadata?: unknown;
}

export function message(conversationId: string, o: MessageOptions = {}): Message {
  const id = o.id ?? `msg_${++seq}`;
  const from = o.from ?? "jane@example.com";
  const sentAt = new Date(Date.now() - (o.minutesAgo ?? 5) * 60_000).toISOString();
  return {
    id,
    conversationId,
    subject: "Question",
    content: o.text ?? "Hi! When do applications open?",
    contentHtml: null,
    senderId: `ctc_${seq}`,
    isInbound: o.inbound ?? true,
    attachmentsCount: o.attachments ?? 0,
    metadata: o.metadata ?? { from: { email: from, name: "Jane" }, headers: { From: `Jane <${from}>`, ...o.headers } },
    sentAt,
    createdAt: sentAt,
  };
}

export function conversation(
  o: { id?: string; subject?: string; messages?: MessageOptions[]; messagesCount?: number } = {},
): ConversationDetail {
  const id = o.id ?? `cnv_${++seq}`;
  const messages = (o.messages ?? [{}]).map((m) => message(id, m));
  const last = messages.at(-1)!;
  return {
    id,
    subject: o.subject ?? "Question",
    status: "open",
    messagesCount: o.messagesCount ?? messages.length,
    commentsCount: 0,
    attachmentsCount: messages.reduce((n, m) => n + m.attachmentsCount, 0),
    snoozedUntil: null,
    url: `https://jelly.example/conversations/${id}`,
    markdownUrl: null,
    messagesUrl: null,
    commentsUrl: null,
    draftReplyUrl: null,
    createdAt: messages[0]!.createdAt,
    lastMessageAt: last.createdAt,
    updatedAt: last.createdAt,
    messages,
    comments: [],
  };
}

export const fixtures = {
  clean: () => conversation({ id: "cnv_clean" }),
  noreplySender: () => conversation({ messages: [{ from: "no-reply@service.example" }] }),
  notificationsSender: () => conversation({ messages: [{ from: "notifications@github.com" }] }),
  mailerDaemon: () => conversation({ messages: [{ from: "MAILER-DAEMON@mx.example.com" }] }),
  autoSubmitted: () => conversation({ messages: [{ headers: { "Auto-Submitted": "auto-replied" } }] }),
  autoSubmittedNo: () => conversation({ messages: [{ headers: { "Auto-Submitted": "no" } }] }),
  bulkPrecedence: () => conversation({ messages: [{ headers: { Precedence: "bulk" } }] }),
  listUnsubscribe: () => conversation({ messages: [{ headers: { "List-Unsubscribe": "<mailto:unsub@x.example>" } }] }),
  withAttachment: () => conversation({ messages: [{ attachments: 1 }] }),
  longThread: () =>
    conversation({
      messages: [
        { minutesAgo: 50 },
        { inbound: false, from: "team@ours.example", minutesAgo: 40 },
        { minutesAgo: 30 },
        { inbound: false, from: "team@ours.example", minutesAgo: 20 },
        { minutesAgo: 10 },
      ],
    }),
  latestOutbound: () =>
    conversation({ messages: [{ minutesAgo: 30 }, { inbound: false, from: "team@ours.example", minutesAgo: 5 }] }),
  unknownSender: () => conversation({ messages: [{ metadata: {} }] }),
};
