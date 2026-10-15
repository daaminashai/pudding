// The shapes /api/state returns (see src/server.ts and src/state.ts).

export interface Flag {
  kind: string;
  detail: string;
}

export interface ThreadEntry {
  kind: "inbound" | "outbound" | "note";
  from: string;
  at: string;
  text: string;
  newText?: string;
}

export type DraftStatus = "pending" | "approved" | "sent" | "discarded" | "stale";
export type DraftKind = "reply" | "confirmation";

export interface Draft {
  id: number;
  kind: DraftKind;
  conversationId: string;
  messageId: string;
  subject: string;
  sender: string | null;
  senderName: string | null;
  conversationUrl: string | null;
  receivedAt: string;
  thread: ThreadEntry[];
  question: string;
  draft: string;
  confidence: number;
  needsHuman: boolean;
  note: string;
  flags: Flag[];
  status: DraftStatus;
  statusReason: string;
  finalText: string | null;
  updatedAt: string;
}

export interface Skipped {
  messageId: string;
  conversationId: string;
  subject: string;
  sender: string | null;
  reason: string;
  at: string;
}

export interface ScanProgress {
  phase: "listing" | "drafting" | "done";
  message: string;
  conversations: number;
  unchanged: number;
  processed: number;
  drafted: number;
  skipped: number;
  errors: string[];
}

export interface BulkStatus {
  kind: DraftKind;
  /** Every draft in the run, in sending order. */
  ids: number[];
  running: boolean;
  total: number;
  processed: number;
  sent: number;
  failed: Array<{ id: number; subject: string; error: string }>;
  stoppedReason: string | null;
  current: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Snapshot {
  drafts: Draft[];
  confirmations: Draft[];
  done: Draft[];
  skipped: Skipped[];
  scan: { running: boolean; progress: ScanProgress | null; error: string | null; finishedAt: string | null };
  sending: { reasonUnavailable: string | null };
  bulk: BulkStatus | null;
  bulkGapSeconds: number;
}

export interface ApproveResult {
  status: "sent" | "approved";
  text: string;
  url: string | null;
  warning: string | null;
}

export interface RefreshResult {
  /** Drafts waiting in To review and Confirmations that were checked. */
  checked: number;
  /** Taken out of the queue: answered or archived in Jelly, or a newer email arrived. */
  removed: number;
  /** Of those, ones with a newer email, which Check inbox drafts again. */
  newer: number;
  errors: string[];
}

export interface DiscardResult {
  discarded: number;
  /** Drafts left alone because they were being sent or rewritten. */
  failed: Array<{ id: number; subject: string; error: string }>;
}
