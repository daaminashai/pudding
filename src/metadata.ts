// Marmalade types `metadata` as an open object, so until a real payload has been
// inspected these readers accept the common shapes and fail closed elsewhere
// (an unknown sender is a guardrail failure, not a pass).
import type { Message } from "./marmalade.js";

/** Lower-cased header name -> all values seen. */
export type Headers = Map<string, string[]>;

const MAX_DEPTH = 3;

export function extractHeaders(metadata: unknown): Headers | null {
  const container = findKey(metadata, "headers", 0);
  if (container === undefined) return null;
  const headers: Headers = new Map();
  const add = (name: unknown, value: unknown) => {
    if (typeof name !== "string") return;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const key = name.trim().toLowerCase();
      headers.set(key, [...(headers.get(key) ?? []), String(v).trim()]);
    }
  };

  if (typeof container === "string") {
    parseRawHeaders(container, add);
  } else if (Array.isArray(container)) {
    for (const entry of container) {
      if (Array.isArray(entry)) add(entry[0], entry[1]);
      else if (isRecord(entry)) add(entry.name ?? entry.key ?? entry.header, entry.value);
    }
  } else if (isRecord(container)) {
    for (const [name, value] of Object.entries(container)) add(name, value);
  } else {
    return null;
  }
  return headers;
}

export function headerValues(headers: Headers | null, name: string): string[] {
  return headers?.get(name.toLowerCase()) ?? [];
}

function parseRawHeaders(raw: string, add: (name: string, value: string) => void): void {
  // Unfold continuation lines, then split "Name: value".
  for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) add(line.slice(0, idx), line.slice(idx + 1));
  }
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface SenderInfo {
  /** The address we'd be replying to and rate-limit on. Null if unknown. */
  from: string | null;
  /** Every address that could identify the sender (From, Reply-To, Sender...). */
  all: string[];
  name: string | null;
}

const SENDER_KEYS = ["from", "sender", "senderEmail", "sender_email", "fromEmail", "from_email", "replyTo", "reply_to"];
const NAME_KEYS = ["fromName", "from_name", "senderName", "sender_name"];

export function extractSender(message: Message): SenderInfo {
  const metadata = message.metadata;
  const headers = extractHeaders(metadata);
  const found: string[] = [];
  let name: string | null = null;

  const collect = (value: unknown) => {
    for (const s of flattenStrings(value)) {
      for (const match of s.match(EMAIL) ?? []) found.push(match.toLowerCase());
    }
  };

  // Header From first so it wins as the primary address when present.
  for (const header of ["from", "reply-to", "sender"]) {
    for (const value of headerValues(headers, header)) collect(value);
  }
  if (isRecord(metadata)) {
    for (const key of SENDER_KEYS) {
      const value = findKey(metadata, key, 0);
      if (value !== undefined) collect(value);
      if (name === null && isRecord(value) && typeof value.name === "string") name = value.name;
    }
    for (const key of NAME_KEYS) {
      const value = findKey(metadata, key, 0);
      if (name === null && typeof value === "string") name = value;
    }
  }
  if (message.senderId) collect(message.senderId);

  const fromHeader = headerValues(headers, "from")[0];
  if (name === null && fromHeader) {
    const match = /^\s*"?([^"<]+?)"?\s*</.exec(fromHeader);
    if (match?.[1]) name = match[1].trim();
  }

  const all = [...new Set(found)];
  return { from: all[0] ?? null, all, name };
}

/** Attachments listed in metadata, in case attachmentsCount lags behind. */
export function metadataAttachmentCount(metadata: unknown): number {
  const value = findKey(metadata, "attachments", 0);
  return Array.isArray(value) ? value.length : 0;
}

function findKey(value: unknown, key: string, depth: number): unknown {
  if (!isRecord(value) || depth > MAX_DEPTH) return undefined;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(value)) {
    if (k.toLowerCase() === lower) return v;
  }
  for (const v of Object.values(value)) {
    const nested = findKey(v, key, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function flattenStrings(value: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => flattenStrings(v, depth + 1));
  if (isRecord(value)) {
    const preferred = value.email ?? value.address ?? value.value;
    return preferred !== undefined ? flattenStrings(preferred, depth + 1) : [];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
