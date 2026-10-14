// Everything that reaches stdout/stderr or an error message goes through redact().
// Known secret values are replaced verbatim; the patterns catch anything that
// looks like a credential even if it was never registered.

const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (!value || value.length < 6) return;
  secrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) secrets.add(encoded);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/(authorization["']?\s*[:=]\s*["']?)[^"'\n]+/gi, "$1[REDACTED]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, "$1[REDACTED]"],
  [/((?:x-)?csrf[-_]?token["']?\s*[:=]\s*["']?)[^"'\s,&;]+/gi, "$1[REDACTED]"],
  [/(authenticity_token["']?\s*[:=]\s*["']?)[^"'\s,&;]+/gi, "$1[REDACTED]"],
  [/(hooks\.slack\.com\/services\/)[^\s"']+/gi, "$1[REDACTED]"],
  [/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]"],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/mrmld_[A-Za-z0-9]+/g, "[REDACTED]"],
];

export function redact(input: string): string {
  let out = input;
  // Longest first so a secret that contains another is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}

export function clearSecretsForTests(): void {
  secrets.clear();
}
