import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rotator-account-service-"));
process.env.CODEX_SWITCHER_HOME = path.join(testRoot, "home");
process.env.CODEX_SWITCHER_AUTH_PATH = path.join(testRoot, "device", "auth.json");

const { buildExtractedAuthFromTokens, readCurrentAuthFile, buildStoredAccount } = await import("./auth-file.js");
const {
  AccountServiceError,
  activateAccountOnDevice,
  readRotationPolicy,
  refreshAccountLimits,
  rotateAccountOnDevice,
  syncCurrentDeviceAuth,
  updateRotationPolicy,
} = await import("./account-service.js");
const { withMutationLock } = await import("./mutation-lock.js");
const { loadStore, saveStore } = await import("./store.js");
const { CODEX_AUTH_PATH } = await import("./config.js");
import type { StoreFile } from "./types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await fs.rm(process.env.CODEX_SWITCHER_HOME!, { recursive: true, force: true });
  await fs.rm(path.dirname(process.env.CODEX_SWITCHER_AUTH_PATH!), { recursive: true, force: true });
  await fs.mkdir(path.dirname(process.env.CODEX_SWITCHER_AUTH_PATH!), { recursive: true });
  globalThis.fetch = async () => {
    throw new Error("Unexpected fetch call");
  };
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeJwt(payload: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function makeAuthBundle(
  accountId: string,
  email: string,
  planType = "pro",
) {
  const authClaims = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: planType,
  };
  const accessToken = makeJwt({
    exp: 2_000_000_000,
    email,
    "https://api.openai.com/auth": authClaims,
  });
  const idToken = makeJwt({
    exp: 2_000_000_000,
    email,
    "https://api.openai.com/auth": authClaims,
  });
  const refreshToken = `${accountId}-refresh-token`;

  return buildExtractedAuthFromTokens({
    accessToken,
    refreshToken,
    idToken,
    accountId,
    email,
    planType,
  });
}

async function writeCurrentAuth(auth: ReturnType<typeof makeAuthBundle>) {
  await fs.writeFile(CODEX_AUTH_PATH, JSON.stringify(auth.rawAuth, null, 2), "utf8");
}

function makeStore(accounts: Array<ReturnType<typeof buildStoredAccount>>): StoreFile {
  return {
    version: 1 as const,
    thresholds: { notifyPercent: 80 },
    rotationPolicy: {
      preferredAliases: [],
      reserveAliases: [],
      heavyRun: { maxPrimaryUsedPercent: 60, maxWeeklyUsedPercent: 80 },
    },
    lastSyncedAt: null,
    accounts,
  };
}

test("syncCurrentDeviceAuth stores the live auth bundle", async () => {
  const auth = makeAuthBundle("account-1", "person@example.com");
  await writeCurrentAuth(auth);

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "account-1");
    return jsonResponse(200, {
      plan_type: "pro",
      rate_limit: { allowed: true, limit_reached: false },
      code_review_rate_limit: { allowed: true, limit_reached: false },
      credits: { has_credits: true, unlimited: false, balance: "10" },
    });
  };

  const result = await syncCurrentDeviceAuth();
  const store = await loadStore();

  assert.equal(result.created, true);
  assert.equal(result.alias, "acc1");
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0]?.email, "person@example.com");
  assert.equal(store.accounts[0]?.usage?.error, null);
});

test("activateAccountOnDevice writes auth.json and increments usage count", async () => {
  const account = buildStoredAccount(makeAuthBundle("account-2", "device@example.com"), "acc1");
  await saveStore(makeStore([account]));

  const result = await activateAccountOnDevice("acc1");
  const currentAuth = await readCurrentAuthFile();
  const store = await loadStore();

  assert.equal(result.account.alias, "acc1");
  assert.equal(currentAuth.accountId, "account-2");
  assert.equal(store.accounts[0]?.usageCount, 1);
});

test("refreshAccountLimits aggregates failures instead of throwing per-account usage errors", async () => {
  const first = buildStoredAccount(makeAuthBundle("account-1", "first@example.com"), "acc1");
  const second = buildStoredAccount(makeAuthBundle("account-2", "second@example.com"), "acc2");
  await saveStore(makeStore([first, second]));

  globalThis.fetch = async (_input, init) => {
    const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
    if (accountId === "account-1") {
      return jsonResponse(200, {
        plan_type: "pro",
        rate_limit: { allowed: true, limit_reached: false },
        code_review_rate_limit: { allowed: true, limit_reached: false },
        credits: { has_credits: true, unlimited: false, balance: "10" },
      });
    }

    return jsonResponse(500, { error: "nope" });
  };

  const result = await refreshAccountLimits();
  const store = await loadStore();
  const failedAccount = store.accounts.find((account) => account.alias === "acc2");

  assert.equal(result.total, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0]?.alias, "acc2");
  assert.match(failedAccount?.usage?.error ?? "", /Usage request failed/);
});

function makeUsage(primaryPercent: number, weeklyPercent: number, error: string | null = null) {
  return {
    planType: "pro",
    rateLimit:
      error == null
        ? {
            allowed: true,
            limitReached: false,
            primaryWindow: {
              usedPercent: primaryPercent,
              limitWindowSeconds: null,
              resetAfterSeconds: null,
              resetAt: null,
            },
            secondaryWindow: {
              usedPercent: weeklyPercent,
              limitWindowSeconds: null,
              resetAfterSeconds: null,
              resetAt: null,
            },
          }
        : null,
    codeReviewRateLimit: null,
    credits: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    error,
  };
}

test("rotateAccountOnDevice switches to the healthiest non-current account", async () => {
  const firstAuth = makeAuthBundle("account-1", "first@example.com");
  const first = buildStoredAccount(firstAuth, "acc1");
  first.usage = makeUsage(1, 3);
  const secondAuth = makeAuthBundle("account-2", "second@example.com");
  const second = buildStoredAccount(secondAuth, "acc2");
  second.usage = makeUsage(2, 6);

  await saveStore(makeStore([first, second]));
  await writeCurrentAuth(firstAuth);

  const result = await rotateAccountOnDevice();
  const currentAuth = await readCurrentAuthFile();
  const store = await loadStore();
  const rotated = store.accounts.find((account) => account.alias === "acc2");

  assert.equal(result.changed, true);
  assert.equal(result.selectedAlias, "acc2");
  assert.equal(result.reason, "rotate");
  assert.equal(currentAuth.accountId, "account-2");
  assert.equal(rotated?.usageCount, 1);
});

test("rotateAccountOnDevice keeps the current account when no healthy alternative exists", async () => {
  const firstAuth = makeAuthBundle("account-1", "first@example.com");
  const first = buildStoredAccount(firstAuth, "acc1");
  first.usage = makeUsage(1, 3);
  const second = buildStoredAccount(makeAuthBundle("account-2", "second@example.com"), "acc2");
  second.usage = makeUsage(0, 0, "Token refresh failed (401)");

  await saveStore(makeStore([first, second]));
  await writeCurrentAuth(firstAuth);

  const result = await rotateAccountOnDevice();
  const currentAuth = await readCurrentAuthFile();
  const store = await loadStore();
  const current = store.accounts.find((account) => account.alias === "acc1");

  assert.equal(result.changed, false);
  assert.equal(result.selectedAlias, "acc1");
  assert.equal(result.reason, "keep-current");
  assert.equal(currentAuth.accountId, "account-1");
  assert.equal(current?.usageCount, 0);
});

test("updateRotationPolicy persists preferred and reserve aliases", async () => {
  const first = buildStoredAccount(makeAuthBundle("account-1", "first@example.com", "team"), "biz1");
  const second = buildStoredAccount(makeAuthBundle("account-2", "second@example.com", "team"), "biz2");
  const third = buildStoredAccount(makeAuthBundle("account-3", "third@example.com", "pro"), "pro1");
  await saveStore(makeStore([first, second, third]));

  const result = await updateRotationPolicy({
    preferredAliases: ["biz1", "biz2"],
    reserveAliases: ["pro1"],
    maxPrimaryUsedPercent: 55,
    maxWeeklyUsedPercent: 75,
  });
  const readBack = await readRotationPolicy();

  assert.deepEqual(result.policy, {
    preferredAliases: ["biz1", "biz2"],
    reserveAliases: ["pro1"],
    heavyRun: {
      maxPrimaryUsedPercent: 55,
      maxWeeklyUsedPercent: 75,
    },
  });
  assert.deepEqual(readBack.policy, result.policy);
});

test("rotateAccountOnDevice uses reserve only when preferred accounts are above threshold", async () => {
  const businessOneAuth = makeAuthBundle("account-1", "first@example.com", "team");
  const businessOne = buildStoredAccount(businessOneAuth, "biz1");
  businessOne.usage = makeUsage(75, 82);
  const businessTwo = buildStoredAccount(makeAuthBundle("account-2", "second@example.com", "team"), "biz2");
  businessTwo.usage = makeUsage(70, 90);
  const pro = buildStoredAccount(makeAuthBundle("account-3", "third@example.com", "pro"), "pro1");
  pro.usage = makeUsage(10, 20);

  const store = makeStore([businessOne, businessTwo, pro]);
  store.rotationPolicy = {
    preferredAliases: ["biz1", "biz2"],
    reserveAliases: ["pro1"],
    heavyRun: { maxPrimaryUsedPercent: 60, maxWeeklyUsedPercent: 80 },
  };
  await saveStore(store);
  await writeCurrentAuth(businessOneAuth);

  const result = await rotateAccountOnDevice();
  const currentAuth = await readCurrentAuthFile();

  assert.equal(result.changed, true);
  assert.equal(result.selectedAlias, "pro1");
  assert.equal(result.reason, "fallback");
  assert.equal(result.pool, "reserve");
  assert.equal(currentAuth.accountId, "account-3");
});

test("mutation lock rejects overlapping writers", async () => {
  await withMutationLock("test-lock", async () => {
    await assert.rejects(syncCurrentDeviceAuth(), (error: unknown) => {
      assert.equal(error instanceof AccountServiceError, true);
      assert.equal((error as { code?: string }).code, "OPERATION_IN_PROGRESS");
      return true;
    });
  });
});
