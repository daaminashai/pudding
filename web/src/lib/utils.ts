import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { plainReply, textToHtml } from "../../../src/reply-html";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Only http(s) links from the server are ever rendered as links. */
export function safeUrl(url: unknown): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function duration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

/** Copies a reply with the same HTML a send uses, so its links paste into Jelly as links. */
export async function copyReply(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([textToHtml(text)], { type: "text/html" }),
        "text/plain": new Blob([plainReply(text)], { type: "text/plain" }),
      }),
    ]);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(plainReply(text));
      return true;
    } catch {
      return false;
    }
  }
}
