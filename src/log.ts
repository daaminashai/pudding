import { redact } from "./redact.js";

type Level = "info" | "warn" | "error";

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  const line = redact(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`);
  (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
