import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanDoc, extractExamples, loadDocs, loadStyle } from "../src/knowledge.js";
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
});

describe("knowledge files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pudding-knowledge-"));
  fs.writeFileSync(path.join(dir, "faq.md"), "Q: Is it free?\nA: Yes.");
  fs.mkdirSync(path.join(dir, "guides"));
  fs.writeFileSync(path.join(dir, "guides", "organizer.txt"), "Doors open at 9.");
  fs.writeFileSync(path.join(dir, "notes.pdf"), "binary");
  fs.writeFileSync(path.join(dir, "_style.md"), "---\nsign_off: |\n  cheers,\n  sam\n---\nKeep it short and lowercase.");

  it("loads .md and .txt docs recursively, skipping _ files", () => {
    expect(loadDocs(dir)).toEqual([
      { name: "faq.md", text: "Q: Is it free?\nA: Yes." },
      { name: path.join("guides", "organizer.txt"), text: "Doors open at 9." },
    ]);
  });

  it("reads the sign-off and style notes", () => {
    expect(loadStyle(dir)).toEqual({ signOff: "cheers,\nsam", notes: "Keep it short and lowercase." });
  });

  it("works with no knowledge dir at all", () => {
    expect(loadDocs(path.join(dir, "missing"))).toEqual([]);
    expect(loadStyle(path.join(dir, "missing"))).toEqual({ signOff: null, notes: "" });
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
