import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeCapture, loginCookie, parseCurl, saveCookieToEnv, shellWords } from "../src/capture.js";

const SESSION = "s3ss10nV4LU3abc";
const CSRF = "csrfV4LU3xyz";

const formCurl = `curl 'https://app.letsjelly.com/hack-club/conversations/test-thread/replies' \\
  -H 'accept: text/vnd.turbo-stream.html, text/html, application/xhtml+xml' \\
  -H 'content-type: application/x-www-form-urlencoded;charset=UTF-8' \\
  -b '_jelly_session=${SESSION}; remember_user_token=${SESSION}2' \\
  -H 'origin: https://app.letsjelly.com' \\
  -H 'x-csrf-token: ${CSRF}' \\
  -H 'user-agent: Mozilla/5.0' \\
  --data-raw 'authenticity_token=${CSRF}&reply%5Bbody%5D=hey+it%27s+a+test&reply%5Bsend_at%5D='`;

describe("capture", () => {
  it("keeps the request's shape and hides every credential", () => {
    const out = describeCapture(parseCurl(formCurl));
    expect(out).not.toContain(SESSION);
    expect(out).not.toContain(CSRF);
    expect(out).toContain("POST https://app.letsjelly.com/hack-club/conversations/test-thread/replies");
    expect(out).toContain("x-csrf-token: [hidden]");
    expect(out).toContain("user-agent: [hidden]");
    expect(out).toContain("content-type: application/x-www-form-urlencoded;charset=UTF-8");
    expect(out).toContain("cookies: _jelly_session, remember_user_token");
    expect(out).toContain('authenticity_token = "[hidden]"');
    expect(out).toContain(`reply[body] = "hey it's a test"`);
    expect(out).toContain('reply[send_at] = ""');
  });

  it("handles cookies sent as a header and JSON bodies", () => {
    const curl = `curl 'https://app.letsjelly.com/api/x' -H 'Cookie: a=${SESSION}' -H 'Content-Type: application/json' --data-raw '{"message":{"body":"hi","token":"${CSRF}"}}'`;
    const out = describeCapture(parseCurl(curl));
    expect(out).not.toContain(SESSION);
    expect(out).not.toContain(CSRF);
    expect(out).toContain('"body": "hi"');
  });

  it("reads ANSI-C quoted bodies Chrome emits for special characters", () => {
    expect(shellWords(`curl $'a\\'b\\nc' "d e" f`)).toEqual(["curl", "a'b\nc", "d e", "f"]);
  });

  it("rejects things that aren't cURL commands", () => {
    expect(() => parseCurl("fetch('https://x')")).toThrow(/Copy as cURL/);
  });

  it("keeps only the login cookies and saves them to .env without touching other settings", () => {
    const cookie = loginCookie(parseCurl(formCurl).cookie + "; _ga=GA1.1.123");
    expect(cookie).toBe(`_jelly_session=${SESSION}`);
    const both = loginCookie(`_ga=1; current_user_session_token=T1; _jelly_session=S1; ph_x=2`);
    expect(both).toBe("current_user_session_token=T1; _jelly_session=S1");

    const env = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pudding-env-")), ".env");
    fs.writeFileSync(env, "MAILBOX_ID=haven\nJELLY_SESSION_COOKIE=old\nMODE=send\n");
    saveCookieToEnv(env, both);
    expect(fs.readFileSync(env, "utf8")).toBe(`MAILBOX_ID=haven\nJELLY_SESSION_COOKIE=${both}\nMODE=send\n`);
    expect(fs.statSync(env).mode & 0o777).toBe(0o600);
  });
});
