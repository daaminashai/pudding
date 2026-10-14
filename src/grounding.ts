// Deterministic backstop for "never invent links, prices or facts": every URL,
// domain, email address, phone number, money amount and number in a drafted
// reply must also appear in the docs, past replies or the thread. Anything else
// flags the draft. It errs towards false positives on purpose.
//
// A link or address in the docs can hold a placeholder in capitals, like
// https://haven.hackclub.com/CITY or CITY@haven.hackclub.com; any lowercase
// word-with-dashes in its place counts as grounded.

// "CITY": four or more capitals inside a link or address in the docs.
const PLACEHOLDER = /([A-Z]{4,})/;

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()"']*)?/gi;
const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

const trimPunctuation = (s: string) => s.replace(/[.,;:!?)\]]+$/, "");
const digitsOnly = (s: string) => s.replace(/\D/g, "");

export function findUngrounded(reply: string, sources: string[]): string[] {
  const source = sources.join("\n").toLowerCase();
  const templates = placeholderTemplates(sources);
  const grounded = (s: string) => source.includes(s) || templates.some((t) => t.test(s));
  const sourcePhones = new Set((source.match(PHONE_RE) ?? []).map(digitsOnly));
  const sourceNumbers = new Set((source.match(NUMBER_RE) ?? []).map(normalizeNumber));
  const lower = reply.toLowerCase();
  const problems = new Set<string>();

  const emails = lower.match(EMAIL_RE) ?? [];
  for (const email of emails) {
    if (!grounded(email)) problems.add(`email ${email}`);
  }
  // Strip emails before looking for domains so "a@b.com" isn't checked twice.
  const withoutEmails = emails.reduce((text, e) => text.split(e).join(" "), lower);

  for (const raw of withoutEmails.match(URL_RE) ?? []) {
    const url = trimPunctuation(raw);
    if (!grounded(url)) problems.add(`link ${url}`);
  }
  for (const raw of withoutEmails.replace(URL_RE, " ").match(DOMAIN_RE) ?? []) {
    const domain = trimPunctuation(raw);
    if (!grounded(domain)) problems.add(`domain ${domain}`);
  }

  const withoutLinks = withoutEmails.replace(URL_RE, " ").replace(DOMAIN_RE, " ");
  for (const raw of withoutLinks.match(PHONE_RE) ?? []) {
    const digits = digitsOnly(raw);
    if (digits.length >= 8 && !sourcePhones.has(digits)) problems.add(`phone ${raw.trim()}`);
  }
  // Every number (prices, durations, dates, percentages) must be one the sources contain.
  for (const raw of withoutLinks.match(NUMBER_RE) ?? []) {
    if (!sourceNumbers.has(normalizeNumber(raw))) problems.add(`number ${raw}`);
  }
  return [...problems];
}

/** Each link or address with a placeholder becomes a pattern; links match with or without https://. */
function placeholderTemplates(sources: string[]): RegExp[] {
  const found = new Set<string>();
  for (const text of sources) {
    for (const token of [...(text.match(URL_RE) ?? []), ...(text.match(EMAIL_RE) ?? [])]) {
      const t = trimPunctuation(token);
      if (PLACEHOLDER.test(t)) found.add(t);
    }
  }
  return [...found].map((t) => {
    const parts = t.replace(/^https?:\/\//i, "").split(PLACEHOLDER);
    const body = parts.map((p, i) => (i % 2 === 1 ? "[a-z0-9]+(?:-[a-z0-9]+)*" : escapeRegExp(p.toLowerCase()))).join("");
    return new RegExp(`^(?:https?://)?${body}$`);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** "1,000" -> "1000", "49.00" -> "49". */
function normalizeNumber(raw: string): string {
  return trimPunctuation(raw).replace(/,/g, "").replace(/\.0+$/, "");
}
