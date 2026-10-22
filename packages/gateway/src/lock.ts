// A lockfile shared by processes: created with O_EXCL and holding the owner's pid. A lock whose process
// has exited (or one left empty by a process that died while taking it) is taken over.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Waits up to `waitMs` for `lock`; returns the release function. `what` names the locked thing in the error. */
export async function fileLock(lock: string, waitMs: number, what: string): Promise<() => void> {
  for (const deadline = Date.now() + waitMs; ; ) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => unlinkSync(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let owner = 0;
      let age = 0;
      try {
        owner = Number(readFileSync(lock, 'utf8')) || 0;
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if ((owner && owner !== process.pid && !alive(owner)) || (!owner && age > 5_000)) {
        try {
          unlinkSync(lock);
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${what} is in use by process ${owner || 'unknown'} (${lock})`);
      await sleep(owner === process.pid ? 50 : 20);
    }
  }
}
