import { describe, expect, it } from "vitest";
import { findUngrounded } from "../src/grounding.js";

const template =
  "Applications open on March 3 at https://apply.example.org/join. The fee is $25.00. " +
  "Questions? Email help@example.org or call +1 (555) 010-2000.";

describe("grounding check", () => {
  it("accepts a reply that only reuses template facts", () => {
    const reply =
      "hey jane! applications open march 3 — apply at https://apply.example.org/join. it's $25. " +
      "questions go to help@example.org or +1 555-010-2000.";
    expect(findUngrounded(reply, [template, "Hi, I'm Jane"])).toEqual([]);
  });

  it("flags an invented link", () => {
    expect(findUngrounded("see https://apply.example.org/faq", [template])).toContain("link https://apply.example.org/faq");
  });

  it("flags an invented bare domain", () => {
    expect(findUngrounded("check example.com for details", [template])).toContain("domain example.com");
  });

  it("flags an invented email address", () => {
    expect(findUngrounded("write to billing@example.org", [template])).toContain("email billing@example.org");
  });

  it("flags invented prices and numbers", () => {
    const problems = findUngrounded("it costs $30 and we reply within 48 hours", [template]);
    expect(problems).toEqual(expect.arrayContaining(["number 30", "number 48"]));
  });

  it("flags an invented phone number", () => {
    expect(findUngrounded("call us on +44 20 7946 0000", [template]).some((p) => p.startsWith("phone"))).toBe(true);
  });

  it("accepts numbers that come from the thread", () => {
    expect(findUngrounded("got it, order 81723 is noted", [template, "my order is #81723"])).toEqual([]);
  });
});
