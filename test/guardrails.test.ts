import { describe, expect, it } from "vitest";
import {
  assignmentFlag,
  attachmentFlag,
  checkAutomatedContent,
  checkHeaders,
  checkSender,
  threadLengthFlag,
} from "../src/guardrails.js";
import type { ConversationDetail } from "../src/marmalade.js";
import { extractHeaders, extractSender } from "../src/metadata.js";
import { fixtures } from "./fixtures.js";

const latest = (c: ConversationDetail) => c.messages.at(-1)!;
const senderOf = (c: ConversationDetail) => extractSender(latest(c));
const headersOf = (c: ConversationDetail) => extractHeaders(latest(c).metadata);

describe("sender skip check", () => {
  it("passes a normal sender", () => {
    expect(checkSender(senderOf(fixtures.clean()))).toMatchObject({ pass: true, detail: "jane@example.com" });
  });

  it.each([
    ["no-reply", fixtures.noreplySender],
    ["notifications", fixtures.notificationsSender],
    ["mailer-daemon", fixtures.mailerDaemon],
  ])("skips %s senders", (_, make) => {
    expect(checkSender(senderOf(make())).pass).toBe(false);
  });

  it.each([
    "noreply@x.com",
    "no_reply@x.com",
    "donotreply@x.com",
    "do-not-reply@x.com",
    "postmaster@x.com",
    "bounce@notifications.x.com",
  ])("treats %s as automated", (address) => {
    expect(checkSender({ from: address, all: [address], name: null }).pass).toBe(false);
  });

  it("skips when any identifying address is automated, e.g. Reply-To", () => {
    const sender = { from: "jane@example.com", all: ["jane@example.com", "noreply@example.com"], name: null };
    expect(checkSender(sender).pass).toBe(false);
  });

  it("passes when there's no address to check (Marmalade often has none)", () => {
    expect(checkSender(senderOf(fixtures.unknownSender())).pass).toBe(true);
  });
});

describe("automated content skip check", () => {
  it.each([
    "Automatic reply: Haven sign up",
    "Out of Office: back Monday",
    "Undeliverable: Haven + Framework 12",
    "Delivery Status Notification (Failure)",
    "Mail Delivery Subsystem",
  ])("skips subject %j", (subject) => {
    expect(checkAutomatedContent(subject, "whatever").pass).toBe(false);
  });

  it("skips Gmail emoji reactions", () => {
    const text = "😃 Aaradhy Patil reacted via Gmail <https://www.google.com/gmail/about/>";
    expect(checkAutomatedContent("Re: venue", text)).toMatchObject({ pass: false, detail: "Gmail emoji reaction" });
  });

  it("passes ordinary emails, including replies to our mass emails", () => {
    expect(checkAutomatedContent("Re: Oraldo: Haven + Framework 12", "My favorite food is tacos!").pass).toBe(true);
  });
});

describe("header skip check", () => {
  it("passes ordinary headers", () => {
    expect(checkHeaders(headersOf(fixtures.clean())).pass).toBe(true);
  });

  it("passes when metadata has no headers at all", () => {
    expect(checkHeaders(null)).toMatchObject({ pass: true, detail: "no headers in metadata" });
  });

  it("skips Auto-Submitted other than no", () => {
    expect(checkHeaders(headersOf(fixtures.autoSubmitted())).pass).toBe(false);
  });

  it("allows Auto-Submitted: no", () => {
    expect(checkHeaders(headersOf(fixtures.autoSubmittedNo())).pass).toBe(true);
  });

  it.each(["bulk", "list", "junk", "Bulk"])("skips Precedence: %s", (value) => {
    expect(checkHeaders(new Map([["precedence", [value]]])).pass).toBe(false);
  });

  it("allows other Precedence values", () => {
    expect(checkHeaders(new Map([["precedence", ["first-class"]]])).pass).toBe(true);
  });

  it("skips List-Unsubscribe", () => {
    expect(checkHeaders(headersOf(fixtures.listUnsubscribe())).pass).toBe(false);
    expect(checkHeaders(headersOf(fixtures.bulkPrecedence())).pass).toBe(false);
  });
});

describe("flags", () => {
  it("flags an assigned conversation", () => {
    const assigned = [{ id: 1, conversationId: "cnv", jellyContactId: "ctc_1", createdAt: new Date().toISOString() }];
    expect(assignmentFlag([])).toBeNull();
    expect(assignmentFlag(assigned)).toEqual({ kind: "assigned", detail: "assigned to ctc_1" });
  });

  it("flags attachments, from the count or from metadata", () => {
    expect(attachmentFlag(latest(fixtures.clean()))).toBeNull();
    expect(attachmentFlag(latest(fixtures.withAttachment()))?.kind).toBe("attachments");
    const listed = { ...latest(fixtures.clean()), metadata: { attachments: [{ filename: "a.pdf" }] } };
    expect(attachmentFlag(listed)?.kind).toBe("attachments");
  });

  it("flags long threads, trusting the higher of the two counts", () => {
    expect(threadLengthFlag(fixtures.clean(), 6)).toBeNull();
    expect(threadLengthFlag(fixtures.longThread(), 5)?.detail).toBe("5 messages in thread");
    expect(threadLengthFlag({ ...fixtures.clean(), messagesCount: 9 }, 6)?.kind).toBe("long_thread");
  });
});
