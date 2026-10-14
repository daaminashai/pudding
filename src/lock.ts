import fs from "node:fs";
import path from "node:path";

// Keeps two copies (say `npm run scan` while `npm start` is open) from working on
// the same state at once. Returns a release function.
export function acquireLock(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pudding.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      if (pid && isAlive(pid)) throw new Error(`Another instance is already running (pid ${pid}, ${file})`);
      fs.rmSync(file, { force: true }); // stale lock from a crashed run
    }
  }
  throw new Error(`Could not acquire ${file}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
