// `npm run capture`: reads a request copied from Chrome DevTools ("Copy as cURL")
// off the clipboard, or from a file given as an argument, and prints and saves only
// its shape: method, URL, header names, cookie names and body fields. Every
// header, cookie and field value that could be a credential is replaced, so the
// result is safe to share. Nothing is sent anywhere.
//
// `npm run capture -- --save-cookie`: also stores the Jelly login cookies from
// that request in .env as JELLY_SESSION_COOKIE, without printing them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Header values that are safe and useful to see; every other header value is hidden. */
const SAFE_HEADERS = new Set([
  "accept",
  "content-type",
  "origin",
  "referer",
  "x-requested-with",
  "turbo-frame",
  "x-turbo-request-id",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
]);
const SECRET_FIELD = /token|csrf|auth|key|secret|session|password|cookie|signature|nonce/i;

export interface CapturedShape {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  cookieNames: string[];
  /** The raw cookie header. Never printed. */
  cookie: string;
  body: string | null;
}

/** The cookies that keep you logged in to Jelly; analytics cookies are dropped. */
const LOGIN_COOKIES = ["current_user_session_token", "_jelly_session"];

export function loginCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter((c) => LOGIN_COOKIES.includes(c.split("=")[0]!))
    .join("; ");
}

/** Sets JELLY_SESSION_COOKIE in an .env file, keeping everything else. */
export function saveCookieToEnv(envFile: string, cookie: string): void {
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const line = `JELLY_SESSION_COOKIE=${cookie}`;
  const next = /^JELLY_SESSION_COOKIE=.*$/m.test(existing)
    ? existing.replace(/^JELLY_SESSION_COOKIE=.*$/m, () => line)
    : `${existing.replace(/\n*$/, "")}\n${line}\n`;
  fs.writeFileSync(envFile, next, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
}

/** Splits a shell command the way bash would for the quoting Chrome emits. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  const s = command.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      current += s.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? s.length : end;
      inWord = true;
    } else if (c === "$" && s[i + 1] === "'") {
      // ANSI-C quoting: $'...' with backslash escapes.
      let j = i + 2;
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === "\\" && j + 1 < s.length) {
          const n = s[++j]!;
          current += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
        } else current += s[j];
      }
      i = j;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length) current += s[++j];
        else current += s[j];
      }
      i = j;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += c === "\\" && i + 1 < s.length ? s[++i] : c;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

export function parseCurl(command: string): CapturedShape {
  const words = shellWords(command.trim());
  if (words[0] !== "curl") throw new Error("That doesn't look like a cURL command. In DevTools use Copy → Copy as cURL.");
  let method: string | null = null;
  let url = "";
  const headers: Array<[string, string]> = [];
  let cookies = "";
  let body: string | null = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const next = () => words[++i] ?? "";
    if (w === "-X" || w === "--request") method = next().toUpperCase();
    else if (w === "-H" || w === "--header") {
      const h = next();
      const idx = h.indexOf(":");
      const name = h.slice(0, idx).trim().toLowerCase();
      const value = h.slice(idx + 1).trim();
      if (name === "cookie") cookies = value;
      else headers.push([name, value]);
    } else if (w === "-b" || w === "--cookie") cookies = next();
    else if (["--data", "--data-raw", "--data-binary", "--data-urlencode", "-d"].includes(w)) body = next();
    else if (w === "--url") url = next();
    else if (!w.startsWith("-") && !url) url = w;
  }
  return {
    method: method ?? (body !== null ? "POST" : "GET"),
    url,
    headers,
    cookieNames: cookies
      .split(";")
      .map((c) => c.split("=")[0]!.trim())
      .filter(Boolean),
    cookie: cookies,
    body,
  };
}

function redactValue(name: string, value: string): string {
  return SECRET_FIELD.test(name) ? "[hidden]" : value;
}

function redactJson(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJson(v, k)]));
  }
  return typeof value === "string" && SECRET_FIELD.test(key) ? "[hidden]" : value;
}

function redactBody(body: string, contentType: string): string {
  if (/json/i.test(contentType) || /^\s*[{[]/.test(body)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(body)), null, 2);
    } catch {
      // fall through
    }
  }
  if (/multipart\/form-data/i.test(contentType)) {
    // Each part: Content-Disposition: form-data; name="field" … value
    return body.replace(/(name="([^"]*)"[^]*?\r?\n\r?\n)([^]*?)(\r?\n--)/g, (_m, head, name, value, tail) =>
      `${head}${redactValue(name, value)}${tail}`,
    );
  }
  // application/x-www-form-urlencoded
  return body
    .split("&")
    .map((pair) => {
      const [rawName = "", rawValue = ""] = pair.split("=");
      const name = decode(rawName);
      return `  ${name} = ${JSON.stringify(redactValue(name, decode(rawValue)))}`;
    })
    .join("\n");
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** The shareable summary: nothing in it can be used to log in as you. */
export function describeCapture(c: CapturedShape): string {
  const contentType = c.headers.find(([n]) => n === "content-type")?.[1] ?? "";
  const url = new URL(c.url);
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_FIELD.test(key)) url.searchParams.set(key, "[hidden]");
  }
  return [
    `${c.method} ${url.toString()}`,
    "",
    "Headers:",
    ...c.headers.map(([n, v]) => `  ${n}: ${SAFE_HEADERS.has(n) ? v : "[hidden]"}`),
    `  cookie: [hidden] (cookies: ${c.cookieNames.join(", ") || "none"})`,
    "",
    "Body:",
    c.body === null ? "  (none)" : redactBody(c.body, contentType),
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const raw = file ? fs.readFileSync(file, "utf8") : execFileSync("pbpaste", { encoding: "utf8" });
  const captured = parseCurl(raw);
  const summary = describeCapture(captured);
  const out = path.resolve("data", "jelly-request.txt");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${summary}\n`);
  process.stdout.write(`${summary}\n\nSaved (secrets hidden) to ${path.relative(process.cwd(), out)}\n`);

  if (args.includes("--save-cookie")) {
    const cookie = loginCookie(captured.cookie);
    const missing = LOGIN_COOKIES.filter((name) => !cookie.includes(`${name}=`));
    if (missing.length > 0) throw new Error(`That request has no ${missing.join(" or ")} cookie, so nothing was saved.`);
    saveCookieToEnv(path.resolve(".env"), cookie);
    process.stdout.write("Saved your Jelly login to .env as JELLY_SESSION_COOKIE (not shown). Restart pudding to use it.\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
