import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Flag } from "./guardrails.js";
import type { Example } from "./knowledge.js";
import { stripQuoted, type ThreadEntry } from "./thread.js";

export type DraftStatus = "pending" | "approved" | "sent" | "discarded" | "stale";

export interface DraftContent {
  draft: string;
  confidence: number;
  needsHuman: boolean;
  note: string;
  flags: Flag[];
}

export interface NewDraft extends DraftContent {
  conversationId: string;
  messageId: string;
  subject: string;
  sender: string | null;
  senderName: string | null;
  conversationUrl: string | null;
  receivedAt: string;
  thread: ThreadEntry[];
  /** The latest inbound message's text; becomes the "question" half of a learned example. */
  question: string;
}

export interface Draft extends NewDraft {
  id: number;
  originalDraft: string;
  status: DraftStatus;
  statusReason: string;
  finalText: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export interface Skipped {
  messageId: string;
  conversationId: string;
  subject: string;
  sender: string | null;
  reason: string;
  at: string;
}

interface DraftDbRow {
  id: number;
  conversation_id: string;
  message_id: string;
  subject: string;
  sender: string | null;
  sender_name: string | null;
  conversation_url: string | null;
  received_at: string;
  thread_json: string;
  question: string;
  draft: string;
  original_draft: string;
  confidence: number;
  needs_human: number;
  note: string;
  flags_json: string;
  status: DraftStatus;
  status_reason: string;
  final_text: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export class State {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        sender TEXT,
        sender_name TEXT,
        conversation_url TEXT,
        received_at TEXT NOT NULL,
        thread_json TEXT NOT NULL,
        question TEXT NOT NULL,
        draft TEXT NOT NULL,
        original_draft TEXT NOT NULL,
        confidence REAL NOT NULL,
        needs_human INTEGER NOT NULL,
        note TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT NOT NULL DEFAULT '',
        final_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS drafts_status ON drafts (status, received_at);
      CREATE INDEX IF NOT EXISTS drafts_conversation ON drafts (conversation_id, status);
      CREATE TABLE IF NOT EXISTS skipped (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        sender TEXT,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      );
      -- When each conversation was last checked, by its lastMessageAt, so a scan
      -- only fetches conversations with new activity.
      CREATE TABLE IF NOT EXISTS checked (
        conversation_id TEXT PRIMARY KEY,
        last_message_at TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      -- Q&A pairs learned from past conversations, cached by conversation updatedAt.
      CREATE TABLE IF NOT EXISTS learned (
        conversation_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        examples_json TEXT NOT NULL
      );
    `);
  }

  /** True if this inbound message already has a draft or was skipped. */
  hasSeen(messageId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM drafts WHERE message_id = ?").get(messageId) !== undefined ||
      this.db.prepare("SELECT 1 FROM skipped WHERE message_id = ?").get(messageId) !== undefined
    );
  }

  hasDraft(messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM drafts WHERE message_id = ?").get(messageId) !== undefined;
  }

  getSkipped(messageId: string): Skipped | undefined {
    return this.db
      .prepare(
        `SELECT message_id AS messageId, conversation_id AS conversationId, subject, sender, reason, at
         FROM skipped WHERE message_id = ?`,
      )
      .get(messageId) as Skipped | undefined;
  }

  removeSkipped(messageId: string): void {
    this.db.prepare("DELETE FROM skipped WHERE message_id = ?").run(messageId);
  }

  insertDraft(d: NewDraft, now = new Date()): number {
    const at = now.toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO drafts (conversation_id, message_id, subject, sender, sender_name, conversation_url, received_at,
           thread_json, question, draft, original_draft, confidence, needs_human, note, flags_json, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        d.conversationId,
        d.messageId,
        d.subject,
        d.sender,
        d.senderName,
        d.conversationUrl,
        d.receivedAt,
        JSON.stringify(d.thread),
        d.question,
        d.draft,
        d.draft,
        d.confidence,
        d.needsHuman ? 1 : 0,
        d.note,
        JSON.stringify(d.flags),
        at,
        at,
      );
    return Number(result.lastInsertRowid);
  }

  /** Replaces the draft text and assessment (e.g. after "regenerate"). */
  updateDraft(id: number, c: DraftContent, now = new Date()): void {
    this.db
      .prepare(
        `UPDATE drafts SET draft = ?, confidence = ?, needs_human = ?, note = ?, flags_json = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(c.draft, c.confidence, c.needsHuman ? 1 : 0, c.note, JSON.stringify(c.flags), now.toISOString(), id);
  }

  setStatus(id: number, status: DraftStatus, reason: string, finalText: string | null = null, now = new Date()): void {
    const at = now.toISOString();
    this.db
      .prepare(
        `UPDATE drafts SET status = ?, status_reason = ?, final_text = COALESCE(?, final_text), updated_at = ?,
           decided_at = ? WHERE id = ?`,
      )
      .run(status, reason, finalText, at, at, id);
  }

  getDraft(id: number): Draft | undefined {
    const row = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftDbRow | undefined;
    return row ? toDraft(row) : undefined;
  }

  pendingDrafts(): Draft[] {
    return (
      this.db.prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY received_at ASC").all() as DraftDbRow[]
    ).map(toDraft);
  }

  decidedDrafts(limit = 50): Draft[] {
    return (
      this.db
        .prepare("SELECT * FROM drafts WHERE status != 'pending' ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as DraftDbRow[]
    ).map(toDraft);
  }

  /** Pending drafts in this conversation that aren't for `exceptMessageId` become stale. */
  staleConversation(conversationId: string, reason: string, exceptMessageId?: string, now = new Date()): number {
    const at = now.toISOString();
    return this.db
      .prepare(
        `UPDATE drafts SET status = 'stale', status_reason = ?, updated_at = ?
         WHERE conversation_id = ? AND status = 'pending' AND message_id != ?`,
      )
      .run(reason, at, conversationId, exceptMessageId ?? "").changes;
  }

  addSkipped(s: Omit<Skipped, "at">, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO skipped (message_id, conversation_id, subject, sender, reason, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO NOTHING`,
      )
      .run(s.messageId, s.conversationId, s.subject, s.sender, s.reason, now.toISOString());
  }

  recentSkipped(limit = 50): Skipped[] {
    return (
      this.db
        .prepare(
          `SELECT message_id AS messageId, conversation_id AS conversationId, subject, sender, reason, at
           FROM skipped ORDER BY at DESC LIMIT ?`,
        )
        .all(limit) as Skipped[]
    );
  }

  /** Replies a person approved, newest first, as examples for future drafts. */
  approvedExamples(limit: number): Example[] {
    const rows = this.db
      .prepare(
        `SELECT subject, question, final_text, decided_at FROM drafts
         WHERE status IN ('approved', 'sent') AND final_text IS NOT NULL ORDER BY decided_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ subject: string; question: string; final_text: string; decided_at: string }>;
    return rows.map((r) => ({
      subject: r.subject,
      question: r.question,
      reply: r.final_text,
      at: r.decided_at,
      source: "approved",
    }));
  }

  /** The conversation's lastMessageAt when it was last checked, if it has been. */
  lastChecked(conversationId: string): string | undefined {
    const row = this.db.prepare("SELECT last_message_at FROM checked WHERE conversation_id = ?").get(conversationId) as
      | { last_message_at: string }
      | undefined;
    return row?.last_message_at;
  }

  markChecked(conversationId: string, lastMessageAt: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO checked (conversation_id, last_message_at, checked_at) VALUES (?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET last_message_at = excluded.last_message_at,
           checked_at = excluded.checked_at`,
      )
      .run(conversationId, lastMessageAt, now.toISOString());
  }

  getLearned(conversationId: string): { updatedAt: string; examples: Example[] } | undefined {
    const row = this.db
      .prepare("SELECT updated_at, examples_json FROM learned WHERE conversation_id = ?")
      .get(conversationId) as { updated_at: string; examples_json: string } | undefined;
    return row ? { updatedAt: row.updated_at, examples: JSON.parse(row.examples_json) } : undefined;
  }

  putLearned(conversationId: string, updatedAt: string, examples: Example[]): void {
    this.db
      .prepare(
        `INSERT INTO learned (conversation_id, updated_at, examples_json) VALUES (?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET updated_at = excluded.updated_at,
           examples_json = excluded.examples_json`,
      )
      .run(conversationId, updatedAt, JSON.stringify(examples));
  }

  close(): void {
    this.db.close();
  }
}

function toDraft(r: DraftDbRow): Draft {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    subject: r.subject,
    sender: r.sender,
    senderName: r.sender_name,
    conversationUrl: r.conversation_url,
    receivedAt: r.received_at,
    // Drafts saved before newText existed get it filled in here.
    thread: (JSON.parse(r.thread_json) as ThreadEntry[]).map((e) => ({ ...e, newText: e.newText ?? stripQuoted(e.text) })),
    question: r.question,
    draft: r.draft,
    originalDraft: r.original_draft,
    confidence: r.confidence,
    needsHuman: r.needs_human === 1,
    note: r.note,
    flags: JSON.parse(r.flags_json),
    status: r.status,
    statusReason: r.status_reason,
    finalText: r.final_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at,
  };
}
