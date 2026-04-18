import fs from "node:fs/promises";
import path from "node:path";

import { OPERATION_LOCK_PATH } from "./config.js";

type LockRecord = {
  pid: number;
  startedAt: string;
  label: string;
};

export class MutationLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationLockBusyError";
  }
}

function isProcessRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLockRecord() {
  try {
    const raw = JSON.parse(await fs.readFile(OPERATION_LOCK_PATH, "utf8")) as Record<string, unknown>;
    const pid = typeof raw.pid === "number" ? raw.pid : null;
    const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : null;
    const label = typeof raw.label === "string" ? raw.label : null;

    if (!pid || !startedAt || !label) {
      return null;
    }

    return { pid, startedAt, label } satisfies LockRecord;
  } catch {
    return null;
  }
}

function buildBusyMessage(record: LockRecord | null) {
  if (!record) {
    return "Another Codex Rotator mutation is already in progress";
  }

  return `Another Codex Rotator mutation is already in progress (${record.label}, pid ${record.pid})`;
}

async function writeLockRecord(label: string) {
  await fs.mkdir(path.dirname(OPERATION_LOCK_PATH), { recursive: true, mode: 0o700 });
  const handle = await fs.open(OPERATION_LOCK_PATH, "wx", 0o600);

  try {
    const record: LockRecord = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      label,
    };
    await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
  } finally {
    await handle.close();
  }
}

async function acquireLock(label: string, allowReclaim: boolean): Promise<void> {
  try {
    await writeLockRecord(label);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const existing = await readLockRecord();
  if (allowReclaim && existing && !isProcessRunning(existing.pid)) {
    await fs.unlink(OPERATION_LOCK_PATH).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
    await acquireLock(label, false);
    return;
  }

  throw new MutationLockBusyError(buildBusyMessage(existing));
}

async function releaseLock() {
  await fs.unlink(OPERATION_LOCK_PATH).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

export async function withMutationLock<T>(label: string, task: () => Promise<T>) {
  await acquireLock(label, true);

  try {
    return await task();
  } finally {
    await releaseLock();
  }
}
