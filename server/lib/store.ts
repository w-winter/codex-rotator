import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  APP_HOME,
  DEFAULT_NOTIFY_PERCENT,
  DEFAULT_ROTATION_MAX_PRIMARY_USED_PERCENT,
  DEFAULT_ROTATION_MAX_WEEKLY_USED_PERCENT,
  KEY_PATH,
  STORE_PATH,
} from "./config.js";
import type { RotationPolicy, StoreFile } from "./types.js";

type EncryptedPayload = {
  version: number;
  iv: string;
  tag: string;
  data: string;
};

function createDefaultRotationPolicy(): RotationPolicy {
  return {
    preferredAliases: [],
    reserveAliases: [],
    heavyRun: {
      maxPrimaryUsedPercent: DEFAULT_ROTATION_MAX_PRIMARY_USED_PERCENT,
      maxWeeklyUsedPercent: DEFAULT_ROTATION_MAX_WEEKLY_USED_PERCENT,
    },
  };
}

function createEmptyStore(): StoreFile {
  return {
    version: 1,
    thresholds: {
      notifyPercent: DEFAULT_NOTIFY_PERCENT,
    },
    rotationPolicy: createDefaultRotationPolicy(),
    lastSyncedAt: null,
    accounts: [],
  };
}

function normalizePercent(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRotationPolicy(input: unknown): RotationPolicy {
  const defaults = createDefaultRotationPolicy();
  const candidate = input && typeof input === "object" ? (input as Partial<RotationPolicy>) : null;
  const heavyRun = candidate?.heavyRun && typeof candidate.heavyRun === "object"
    ? candidate.heavyRun
    : null;

  return {
    preferredAliases: Array.isArray(candidate?.preferredAliases)
      ? candidate.preferredAliases.filter((alias): alias is string => typeof alias === "string")
      : defaults.preferredAliases,
    reserveAliases: Array.isArray(candidate?.reserveAliases)
      ? candidate.reserveAliases.filter((alias): alias is string => typeof alias === "string")
      : defaults.reserveAliases,
    heavyRun: {
      maxPrimaryUsedPercent: normalizePercent(
        heavyRun && "maxPrimaryUsedPercent" in heavyRun ? heavyRun.maxPrimaryUsedPercent : null,
        defaults.heavyRun.maxPrimaryUsedPercent,
      ),
      maxWeeklyUsedPercent: normalizePercent(
        heavyRun && "maxWeeklyUsedPercent" in heavyRun ? heavyRun.maxWeeklyUsedPercent : null,
        defaults.heavyRun.maxWeeklyUsedPercent,
      ),
    },
  };
}

function normalizeStore(input: unknown): StoreFile {
  const defaults = createEmptyStore();
  const candidate = input && typeof input === "object" ? (input as Partial<StoreFile>) : null;
  const thresholds = candidate?.thresholds && typeof candidate.thresholds === "object"
    ? candidate.thresholds
    : null;

  return {
    version: 1,
    thresholds: {
      notifyPercent: normalizePercent(
        thresholds && "notifyPercent" in thresholds ? thresholds.notifyPercent : null,
        defaults.thresholds.notifyPercent,
      ),
    },
    rotationPolicy: normalizeRotationPolicy(candidate?.rotationPolicy),
    lastSyncedAt: typeof candidate?.lastSyncedAt === "string" ? candidate.lastSyncedAt : null,
    accounts: Array.isArray(candidate?.accounts) ? candidate.accounts : defaults.accounts,
  };
}

async function ensureHome() {
  await fs.mkdir(APP_HOME, { recursive: true, mode: 0o700 });
}

async function ensureKey() {
  await ensureHome();

  try {
    return await fs.readFile(KEY_PATH);
  } catch {
    const key = crypto.randomBytes(32);
    await fs.writeFile(KEY_PATH, key, { mode: 0o600 });
    return key;
  }
}

function encryptStore(store: StoreFile, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const serialized = Buffer.from(JSON.stringify(store), "utf8");
  const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptStore(payload: EncryptedPayload, key: Buffer): StoreFile {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);

  return normalizeStore(JSON.parse(decrypted.toString("utf8")));
}

async function atomicWrite(filePath: string, contents: string) {
  await ensureHome();
  const tempPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, contents, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export async function loadStore(): Promise<StoreFile> {
  const key = await ensureKey();

  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const payload = JSON.parse(raw) as EncryptedPayload;
    return decryptStore(payload, key);
  } catch {
    return createEmptyStore();
  }
}

export async function saveStore(store: StoreFile) {
  const key = await ensureKey();
  const payload = encryptStore(normalizeStore(store), key);
  await atomicWrite(STORE_PATH, JSON.stringify(payload, null, 2));
}

export { createDefaultRotationPolicy };
