import type { ApproveResult, Draft, Snapshot } from "./types";

const TOKEN = document.querySelector<HTMLMetaElement>('meta[name="pudding-token"]')?.content ?? "";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-pudding-token": TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  state: () => call<Snapshot>("/api/state"),
  scan: () => call<Snapshot>("/api/scan", {}),
  approve: (id: number, text: string) => call<ApproveResult>(`/api/drafts/${id}/approve`, { text }),
  discard: (id: number) => call<{ status: string }>(`/api/drafts/${id}/discard`, {}),
  rewrite: (id: number, text: string, instructions: string) =>
    call<Draft>(`/api/drafts/${id}/redo`, { text, instructions }),
  draftAnyway: (messageId: string) =>
    call<{ outcome: string }>(`/api/skipped/${encodeURIComponent(messageId)}/draft`, {}),
};
