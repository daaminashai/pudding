import { afterEach, describe, expect, it } from "vitest";
import { clearSecretsForTests, errorMessage, redact, registerSecret } from "../src/redact.js";

afterEach(() => clearSecretsForTests());

describe("redaction", () => {
  it("removes registered secrets, including URL-encoded forms", () => {
    registerSecret("sess=abc123/xyz==");
    expect(redact("cookie was sess=abc123/xyz== and sess%3Dabc123%2Fxyz%3D%3D")).not.toMatch(/abc123/);
  });

  it("removes bearer tokens, cookies, CSRF tokens and Slack webhooks it was never told about", () => {
    const text = [
      "Authorization: Bearer mk_live_123456",
      "Cookie: _jelly_session=deadbeef; other=1",
      'csrf-token="t0k3n"',
      "authenticity_token=abcdef",
      "https://hooks.slack.com/services/T000/B000/XXXX",
      "sk-ant-api03-secretsecret",
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "mrmld_0123456789abcdef",
    ].join("\n");
    const out = redact(text);
    for (const leaked of ["mk_live_123456", "deadbeef", "t0k3n", "abcdef", "T000/B000", "secretsecret", "uvwxyz123456", "0123456789"]) {
      expect(out).not.toContain(leaked);
    }
  });

  it("redacts error messages", () => {
    registerSecret("supersecretkey");
    expect(errorMessage(new Error("401 with key supersecretkey"))).toBe("401 with key [REDACTED]");
  });
});
