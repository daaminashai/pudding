import { describe, expect, it } from "vitest";
import { findAiTells } from "../src/humanize.js";

describe("AI-style check", () => {
  it("passes a plain, human reply", () => {
    const reply = "hey jane, applications open march 3, you can apply at https://apply.example.org/join. see you there!";
    expect(findAiTells(reply)).toEqual([]);
  });

  it("allows [words](url) links, which are sent as links", () => {
    expect(findAiTells("join [#help](https://chat.example.org/c) on Slack")).toEqual([]);
  });

  it("allows ordinary hyphens and numbers in sentences", () => {
    expect(findAiTells("It's a 2-day event, doors at 9. Bring a laptop.")).toEqual([]);
  });

  it.each([
    ["Sure — here you go", "em dash (—)"],
    ["Applications open in March – see the site", "spaced en dash ( – )"],
    ["The fee is **$25**", "markdown bold"],
    ["## Details\nIt's free", "markdown heading"],
    ["What to bring:\n- laptop\n- charger", "bullet list"],
    ["Steps:\n1. sign up\n2. come", "numbered list"],
    ["Great question! It's free.", '"great question"'],
    ["Thanks for reaching out. It's free.", '"thanks for reaching out"'],
    ["It's free. I hope this helps!", '"I hope this helps"'],
    ["It's free. Feel free to reach out with anything else.", '"feel free to reach out"'],
    ["Don't hesitate to ask.", '"don\'t hesitate to"'],
    ["Certainly! It's free.", "opens with Certainly/Absolutely/Of course"],
    ["I hope this email finds you well.", '"I hope this email finds you…"'],
  ])("flags %j", (text, tell) => {
    expect(findAiTells(text)).toContain(tell);
  });
});
