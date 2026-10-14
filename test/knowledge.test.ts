import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanDoc, cleanExample, extractExamples, loadDocs, loadStyle, type Example } from "../src/knowledge.js";
import { stripQuoted, stripSignature } from "../src/thread.js";
import { conversation } from "./fixtures.js";

describe("learning from past conversations", () => {
  it("pairs each of our replies with the inbound messages before it", () => {
    const c = conversation({
      subject: "Deadline?",
      messages: [
        { text: "when's the deadline?", minutesAgo: 60 },
        { text: "also, is it free?", minutesAgo: 55 },
        { inbound: false, from: "team@ours.example", text: "march 3, and yes it's free!", minutesAgo: 50 },
        { text: "thanks!!", minutesAgo: 40 },
      ],
    });
    expect(extractExamples(c)).toEqual([
      expect.objectContaining({
        subject: "Deadline?",
        question: "when's the deadline?\n\nalso, is it free?",
        reply: "march 3, and yes it's free!",
        source: "past",
      }),
    ]);
  });

  it("ignores conversations with automated senders", () => {
    const c = conversation({
      messages: [{ from: "noreply@service.example" }, { inbound: false, from: "team@ours.example", text: "ok" }],
    });
    expect(extractExamples(c)).toEqual([]);
  });

  it("strips quoted history from replies", () => {
    expect(stripQuoted("sounds good!\n\nOn Mon, Oct 13, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> old stuff")).toBe(
      "sounds good!",
    );
    expect(stripQuoted("yes\n> quoted line\nstill mine")).toBe("yes\nstill mine");
  });

  it("strips Gmail attributions that wrap over two lines", () => {
    const text =
      "My favorite food is tacos!\r\n\r\nOn Wed, Oct 14, 2026 at 12:07\u202fPM Jolly Wang (Hack Club Haven) <\r\n" +
      "haven@hackclub.com> wrote:\r\n\r\n> Hey Oraldo,";
    expect(stripQuoted(text)).toBe("My favorite food is tacos!");
  });

  it("doesn't mistake a sentence starting with On for an attribution", () => {
    expect(stripQuoted("On Saturday we start at 9.\nSee you then")).toBe("On Saturday we start at 9.\nSee you then");
  });

  it("strips our signature block from past replies", () => {
    const withCheers =
      "thats awesome!\n\nYour registration has been confirmed.\n\nCheers\n\nSana Deghat (She/Her)\n\n" +
      "Haven Event Manager\n\nsana@hackclub.com (mailto:sana@hackclub.com)\n\nHack Club is an open source nonprofit.";
    expect(stripSignature(withCheers)).toBe("thats awesome!\n\nYour registration has been confirmed.");
    const tight = "thats awesome!\nYour registration has been confirmed.\nSana Deghat (She/Her)\n\nHaven Event Manager\n\nsana@hackclub.com";
    expect(stripSignature(tight)).toBe("thats awesome!\nYour registration has been confirmed.");
    expect(stripSignature("no signature here.\nbye")).toBe("no signature here.\nbye");
  });

  it("strips Hack Club signatures with a phone line or footer and no email", () => {
    const footer =
      "Hack Club (https://hackclub.com/) is an open source (https://github.com/hackclub/) and financially transparent 501(c)(3) nonprofit.";
    expect(stripSignature(`Me too!! Confirmed :)\n\nSincerely,\n\nBarnav Mitra\n\nHaven Director\n\nT: +1 (646) 555-0100\n\n${footer}`)).toBe(
      "Me too!! Confirmed :)",
    );
    // A reply that was only a signature leaves nothing to learn from.
    expect(stripSignature(`Jolly Wang\n\nHaven Director @ Hack Club HQ\n\nC: +1 (949) 555-0100\n\n${footer}`)).toBe("");
    expect(stripSignature(`Venue details come closer to the event!\n\n${footer}`)).toBe("Venue details come closer to the event!");
  });

  it("keeps a forwarded email that has nothing written above it", () => {
    const fwd = "---------- Forwarded message ---------\nFrom: Haven Plovdiv\nSubject: Haven Plovdiv\n\nHello, a sponsor wants an AI track.";
    expect(stripQuoted(fwd)).toBe(fwd);
    expect(stripQuoted(`see below\n\n${fwd}`)).toBe("see below");
  });
});

describe("cleanExample", () => {
  const ex = (subject: string, reply: string): Example => ({ subject, question: "q", reply, at: "2026-10-01", source: "past" });

  it("drops stock sign-up confirmations, bare greetings and signature-only replies", () => {
    expect(cleanExample(ex("Re: Kacper: Haven + Framework 12", "thats awesome!\n\nYour registration has been confirmed."))).toBeNull();
    expect(cleanExample(ex("Re: S: Haven Sign Up Confirmation", "Hi!"))).toBeNull();
    for (const stock of ["Me too!! Confirmed :)", "cheese is so valid. registration confirmed :)", "Confirmed! Excited to see you at Haven Islamabad :)", "Thanks! Your registration is now confirmed!"]) {
      expect(cleanExample(ex("Re: Bo: Haven Sign Up Confirmation", stock)), stock).toBeNull();
    }
    expect(cleanExample(ex("Question", "Jolly Wang\n\nHaven Director\n\nC: +1 (949) 555-0100"))).toBeNull();
  });

  it("keeps real answers, including ones in confirmation threads", () => {
    const venue = "Some events don't have confirmed venues yet, so location info comes closer to the event. Keep an eye on your inbox, and email your city's team for anything specific.";
    expect(cleanExample(ex("Re: Uday: Haven Sign Up Confirmation", venue))?.reply).toBe(venue);
    expect(cleanExample(ex("Is it free?", "yep!\n\nCheers"))?.reply).toBe("yep!");
  });
});

describe("knowledge files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pudding-knowledge-"));
  fs.writeFileSync(path.join(dir, "faq.md"), "Q: Is it free?\nA: Yes.");
  fs.mkdirSync(path.join(dir, "guides"));
  fs.writeFileSync(path.join(dir, "guides", "organizer.txt"), "Doors open at 9.");
  fs.writeFileSync(path.join(dir, "notes.pdf"), "binary");
  fs.writeFileSync(path.join(dir, "_style.md"), "---\nconfirmation_reply: yay\n---\nKeep it short and lowercase.");

  it("loads .md and .txt docs recursively, skipping _ files", () => {
    expect(loadDocs(dir)).toEqual([
      { name: "faq.md", text: "Q: Is it free?\nA: Yes." },
      { name: path.join("guides", "organizer.txt"), text: "Doors open at 9." },
    ]);
  });

  it("reads the style notes and confirmation reply", () => {
    expect(loadStyle(dir)).toEqual({ notes: "Keep it short and lowercase.", confirmationReply: "yay" });
  });

  it("reads a custom reply for sign-up confirmations", () => {
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), "pudding-style-"));
    fs.writeFileSync(path.join(custom, "_style.md"), '---\nconfirmation_reply: "yay, you\'re confirmed :D"\n---\n');
    expect(loadStyle(custom).confirmationReply).toBe("yay, you're confirmed :D");
  });

  it("works with no knowledge dir at all", () => {
    expect(loadDocs(path.join(dir, "missing"))).toEqual([]);
    expect(loadStyle(path.join(dir, "missing"))).toEqual({
      notes: "",
      confirmationReply: "Thanks! Your registration has been confirmed.",
    });
  });
});

describe("cleanDoc", () => {
  it("drops base64 images from Google Docs exports", () => {
    const doc = [
      "# Guide",
      "![][image1]",
      "Doors open at 9.",
      "![logo](data:image/png;base64,AAAA)",
      "",
      "[image1]: <data:image/png;base64,iVBORw0KGgo>",
    ].join("\n");
    expect(cleanDoc(doc)).toBe("# Guide\n\nDoors open at 9.");
  });
});
