import { describe, expect, it } from "vitest";
import { extractHeaders, extractSender, headerValues } from "../src/metadata.js";
import { message } from "./fixtures.js";

describe("extractHeaders", () => {
  it("returns null when there are no headers", () => {
    expect(extractHeaders(null)).toBeNull();
    expect(extractHeaders({ foo: 1 })).toBeNull();
  });

  it("reads an object of headers case-insensitively", () => {
    const h = extractHeaders({ headers: { "AUTO-SUBMITTED": "auto-generated" } });
    expect(headerValues(h, "auto-submitted")).toEqual(["auto-generated"]);
  });

  it("reads a [{name, value}] array", () => {
    const h = extractHeaders({ headers: [{ name: "Precedence", value: "list" }, { name: "Precedence", value: "bulk" }] });
    expect(headerValues(h, "precedence")).toEqual(["list", "bulk"]);
  });

  it("reads [name, value] tuples", () => {
    expect(headerValues(extractHeaders({ headers: [["List-Unsubscribe", "<x>"]] }), "list-unsubscribe")).toEqual(["<x>"]);
  });

  it("parses a raw header block with folded lines", () => {
    const h = extractHeaders({ headers: "From: a@b.com\r\nList-Unsubscribe: <mailto:x@y.com>,\r\n <https://y.com/u>\r\n" });
    expect(headerValues(h, "list-unsubscribe")).toEqual(["<mailto:x@y.com>, <https://y.com/u>"]);
  });

  it("finds headers nested a level or two down", () => {
    expect(headerValues(extractHeaders({ email: { headers: { Precedence: "junk" } } }), "precedence")).toEqual(["junk"]);
  });
});

describe("extractSender", () => {
  it("prefers the From header and picks up the display name", () => {
    const m = message("c", { metadata: { headers: { From: '"Jane Doe" <Jane@Example.com>' } } });
    expect(extractSender(m)).toEqual({ from: "jane@example.com", all: ["jane@example.com"], name: "Jane Doe" });
  });

  it("collects Reply-To so automated reply addresses are caught too", () => {
    const m = message("c", { metadata: { headers: { From: "jane@example.com", "Reply-To": "noreply@example.com" } } });
    expect(extractSender(m).all).toEqual(["jane@example.com", "noreply@example.com"]);
  });

  it("reads plain metadata fields when there are no headers", () => {
    const m = { ...message("c"), metadata: { senderEmail: "sam@example.org", senderName: "Sam" }, senderId: null };
    expect(extractSender(m)).toMatchObject({ from: "sam@example.org", name: "Sam" });
  });

  it("falls back to senderId when it is an email address", () => {
    const m = { ...message("c"), metadata: null, senderId: "kim@example.net" };
    expect(extractSender(m).from).toBe("kim@example.net");
  });

  it("returns null when nothing identifies the sender", () => {
    const m = { ...message("c"), metadata: {}, senderId: "ctc_123" };
    expect(extractSender(m).from).toBeNull();
  });
});
