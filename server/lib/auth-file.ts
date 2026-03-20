import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CODEX_AUTH_PATH } from "./config.js";
import type { ExtractedAuth, RawAuthJson, StoredAccount, TokenRefreshResult } from "./types.js";

function getObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing or invalid`);
  }

  return value as Record<string, unknown>;
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function decodeJwtPayload(token: string) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function claimString(claims: Record<string, unknown> | null, key: string) {
  return getString(claims?.[key]);
}

function extractMetadataFromToken(idToken: string, accessToken: string) {
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const authClaims =
    ((idClaims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined) ??
      (accessClaims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined)) ||
    null;

  const email =
    claimString(idClaims, "email") ||
    claimString(accessClaims, "email") ||
    claimString((idClaims?.["https://api.openai.com/profile"] as Record<string, unknown> | undefined) ?? null, "email") ||
    null;

  const accountId =
    getString(authClaims?.chatgpt_account_id) ||
    claimString(idClaims, "chatgpt_account_id") ||
    claimString(accessClaims, "chatgpt_account_id") ||
    null;

  const planType =
    getString(authClaims?.chatgpt_plan_type) ||
    claimString(idClaims, "chatgpt_plan_type") ||
    claimString(accessClaims, "chatgpt_plan_type") ||
    null;

  const exp =
    (typeof idClaims?.exp === "number" ? idClaims.exp : null) ??
    (typeof accessClaims?.exp === "number" ? accessClaims.exp : null);

  return {
    email,
    accountId,
    planType,
    tokenExpiresAt: typeof exp === "number" ? new Date(exp * 1000).toISOString() : null,
  };
}

function fingerprint(accessToken: string, refreshToken: string, idToken: string) {
  return crypto
    .createHash("sha256")
    .update(`${accessToken}:${refreshToken}:${idToken}`)
    .digest("hex");
}

function readTokenBundle(rawAuth: RawAuthJson) {
  const tokens = getObject(rawAuth.tokens, "auth.tokens");

  const accessToken = getString(tokens.access_token) || getString(tokens.accessToken);
  const refreshToken = getString(tokens.refresh_token) || getString(tokens.refreshToken);
  const idToken = getString(tokens.id_token) || getString(tokens.idToken);

  if (!accessToken || !refreshToken || !idToken) {
    throw new Error("auth.json token bundle is incomplete");
  }

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: getString(tokens.account_id) || getString(tokens.accountId) || null,
  };
}

export async function readCurrentAuthFile(): Promise<ExtractedAuth> {
  const rawText = await fs.readFile(CODEX_AUTH_PATH, "utf8");
  const rawAuth = JSON.parse(rawText) as RawAuthJson;
  const tokens = readTokenBundle(rawAuth);
  const metadata = extractMetadataFromToken(tokens.idToken, tokens.accessToken);

  return {
    rawAuth,
    fingerprint: fingerprint(tokens.accessToken, tokens.refreshToken, tokens.idToken),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    accountId: tokens.accountId || metadata.accountId,
    email: metadata.email,
    planType: metadata.planType,
    tokenExpiresAt: metadata.tokenExpiresAt,
  };
}

export function readStoredTokens(account: StoredAccount) {
  return readTokenBundle(account.rawAuth);
}

export function buildExtractedAuthFromTokens({
  accessToken,
  refreshToken,
  idToken,
  accountId,
  email,
  planType,
}: {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId?: string | null;
  email?: string | null;
  planType?: string | null;
}): ExtractedAuth {
  const metadata = extractMetadataFromToken(idToken, accessToken);
  const resolvedAccountId = accountId ?? metadata.accountId;
  const nowIso = new Date().toISOString();

  const rawAuth: RawAuthJson = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      ...(resolvedAccountId ? { account_id: resolvedAccountId } : {}),
    },
    last_refresh: nowIso,
  };

  return {
    rawAuth,
    fingerprint: fingerprint(accessToken, refreshToken, idToken),
    accessToken,
    refreshToken,
    idToken,
    accountId: resolvedAccountId,
    email: email ?? metadata.email,
    planType: planType ?? metadata.planType,
    tokenExpiresAt: metadata.tokenExpiresAt,
  };
}

function setIfPresent(target: Record<string, unknown>, snakeKey: string, camelKey: string, value: unknown) {
  if (snakeKey in target) {
    target[snakeKey] = value;
    return;
  }

  if (camelKey in target) {
    target[camelKey] = value;
    return;
  }

  target[snakeKey] = value;
}

export function applyTokenRefresh(account: StoredAccount, refresh: TokenRefreshResult) {
  const nextRaw = structuredClone(account.rawAuth) as RawAuthJson;
  const tokens = getObject(nextRaw.tokens, "auth.tokens");

  setIfPresent(tokens, "access_token", "accessToken", refresh.accessToken);
  setIfPresent(tokens, "refresh_token", "refreshToken", refresh.refreshToken);
  setIfPresent(tokens, "id_token", "idToken", refresh.idToken);
  if (refresh.accountId) {
    setIfPresent(tokens, "account_id", "accountId", refresh.accountId);
  }

  const nowIso = new Date().toISOString();
  setIfPresent(nextRaw, "last_refresh", "lastRefresh", nowIso);

  account.rawAuth = nextRaw;
  account.accountId = refresh.accountId;
  account.email = refresh.email;
  account.planType = refresh.planType;
  account.tokenExpiresAt = refresh.tokenExpiresAt;
  account.lastTokenRefreshAt = nowIso;
  account.fingerprint = fingerprint(refresh.accessToken, refresh.refreshToken, refresh.idToken);
}

export async function writeCurrentAuthFile(rawAuth: RawAuthJson) {
  await fs.mkdir(path.dirname(CODEX_AUTH_PATH), { recursive: true, mode: 0o700 });
  const tempPath = path.join(path.dirname(CODEX_AUTH_PATH), `auth.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, JSON.stringify(rawAuth, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, CODEX_AUTH_PATH);
}

export function buildStoredAccount(auth: ExtractedAuth, alias: string): StoredAccount {
  const nowIso = new Date().toISOString();

  return {
    alias,
    fingerprint: auth.fingerprint,
    email: auth.email,
    accountId: auth.accountId,
    planType: auth.planType,
    tokenExpiresAt: auth.tokenExpiresAt,
    lastSyncedAt: nowIso,
    lastTokenRefreshAt: null,
    lastLimitRefreshAt: null,
    usageCount: 0,
    rawAuth: auth.rawAuth,
    usage: null,
  };
}
