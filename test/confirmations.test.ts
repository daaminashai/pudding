import { describe, expect, it } from "vitest";
import { confirmationText, isConfirmationCandidate } from "../src/confirmations.js";
import type { ThreadEntry } from "../src/thread.js";

const QUOTED =
  "Pizza\n\nOn Sat, 10 Oct 2026, Jolly Wang <haven@hackclub.com> wrote:\n> Thanks for signing up for Haven Hyderabad :D\n>\n> To confirm your registration, reply to this email with your favorite food!";
const inbound = (text: string): ThreadEntry => ({ kind: "inbound", from: "sender", at: "2026-10-10T17:11:24Z", text });
const outbound = (text: string): ThreadEntry => ({ kind: "outbound", from: "us", at: "2026-10-10T18:00:00Z", text });

describe("isConfirmationCandidate", () => {
  it("recognizes replies to the sign-up confirmation by subject", () => {
    for (const subject of [
      "Re: Bela: Haven + Framework 12",
      "Re: Zahra: Haven Sign Up Confirmation",
      "RE: Re: Mikołaj: Haven + Framework 12",
      "AW: Jocksand: Haven Sign-up Confirmation",
    ]) {
      expect(isConfirmationCandidate({ subject, thread: [inbound("Pizza")], question: "Pizza" }), subject).toBe(true);
    }
  });

  it("recognizes them by the quoted confirmation email when the subject was changed", () => {
    expect(isConfirmationCandidate({ subject: "my food", thread: [inbound(QUOTED)], question: "Pizza" })).toBe(true);
  });

  it("ignores other emails, threads we've replied in, and empty replies", () => {
    const subject = "Re: Bela: Haven + Framework 12";
    expect(isConfirmationCandidate({ subject: "Sponsoring?", thread: [inbound("hi")], question: "hi" })).toBe(false);
    expect(isConfirmationCandidate({ subject: "Bela: Haven + Framework 12", thread: [inbound("x")], question: "x" })).toBe(
      false,
    );
    expect(
      isConfirmationCandidate({ subject, thread: [inbound("Pizza"), outbound("confirmed!"), inbound("thanks")], question: "thanks" }),
    ).toBe(false);
    expect(isConfirmationCandidate({ subject, thread: [inbound(QUOTED)], question: "  " })).toBe(false);
  });
});

describe("confirmation checks", () => {
  it("skip threads with a teammate's note", () => {
    const note: ThreadEntry = { kind: "note", from: "teammate", at: "2026-10-10T18:00:00Z", text: "I'll take this" };
    expect(
      isConfirmationCandidate({ subject: "Re: Bela: Haven + Framework 12", thread: [inbound("Pizza"), note], question: "Pizza" }),
    ).toBe(false);
  });

  it("see every message they sent, and text below the quote, without our quoted email", () => {
    const text = confirmationText([
      inbound("can I bring my sister?"),
      inbound(`${QUOTED}\n\nalso is there parking`),
    ]);
    expect(text).toBe(
      "can I bring my sister?\n\n--- their next message ---\n\nPizza\n\nOn Sat, 10 Oct 2026, Jolly Wang <haven@hackclub.com> wrote:\n\nalso is there parking",
    );
  });
});
