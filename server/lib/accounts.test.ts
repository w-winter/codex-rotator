import assert from "node:assert/strict";
import test from "node:test";

import {
  accountRequiresReconnect,
  getMatchingAccount,
  matchesCanonicalAccountIdentity,
  normalizeAlias,
  recommendedAlias,
  selectRotationTarget,
  upsertAccount,
} from "./accounts.js";
import type { ExtractedAuth, StoredAccount, StoreFile, UsageRecord } from "./types.js";

function makeAccount(overrides: Partial<StoredAccount>): StoredAccount {
  return {
    alias: overrides.alias ?? "acc1",
    fingerprint: overrides.fingerprint ?? "fingerprint-1",
    email: overrides.email === undefined ? "person@example.com" : overrides.email,
    accountId: overrides.accountId === undefined ? "account-1" : overrides.accountId,
    planType: overrides.planType === undefined ? "pro" : overrides.planType,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
    lastSyncedAt: overrides.lastSyncedAt ?? "2026-01-01T00:00:00.000Z",
    lastTokenRefreshAt: overrides.lastTokenRefreshAt ?? null,
    lastLimitRefreshAt: overrides.lastLimitRefreshAt ?? null,
    usageCount: overrides.usageCount ?? 0,
    rawAuth: overrides.rawAuth ?? { tokens: {} },
    usage: overrides.usage ?? null,
  };
}

function makeStore(accounts: StoredAccount[]): StoreFile {
  return {
    version: 1,
    thresholds: { notifyPercent: 80 },
    rotationPolicy: {
      preferredAliases: [],
      reserveAliases: [],
      heavyRun: {
        maxPrimaryUsedPercent: 60,
        maxWeeklyUsedPercent: 80,
      },
    },
    lastSyncedAt: null,
    accounts,
  };
}

function makeAuth(overrides: Partial<ExtractedAuth>): ExtractedAuth {
  return {
    rawAuth: overrides.rawAuth ?? { tokens: {} },
    fingerprint: overrides.fingerprint ?? "incoming-fingerprint",
    email: overrides.email === undefined ? "person@example.com" : overrides.email,
    accountId: overrides.accountId === undefined ? "account-1" : overrides.accountId,
    planType: overrides.planType === undefined ? "pro" : overrides.planType,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
    accessToken: overrides.accessToken ?? "access",
    refreshToken: overrides.refreshToken ?? "refresh",
    idToken: overrides.idToken ?? "id",
  };
}

function makeUsage(overrides: Partial<UsageRecord> & { primaryPercent?: number; weeklyPercent?: number }): UsageRecord {
  const error = overrides.error ?? null;

  return {
    planType: overrides.planType ?? "pro",
    rateLimit:
      overrides.rateLimit === undefined
        ? {
            allowed: true,
            limitReached: false,
            primaryWindow: {
              usedPercent: overrides.primaryPercent ?? null,
              limitWindowSeconds: null,
              resetAfterSeconds: null,
              resetAt: null,
            },
            secondaryWindow: {
              usedPercent: overrides.weeklyPercent ?? null,
              limitWindowSeconds: null,
              resetAfterSeconds: null,
              resetAt: null,
            },
          }
        : overrides.rateLimit,
    codeReviewRateLimit: overrides.codeReviewRateLimit ?? null,
    credits: overrides.credits ?? null,
    fetchedAt: overrides.fetchedAt ?? "2026-01-01T00:00:00.000Z",
    error,
    authState: overrides.authState ?? (error == null ? "valid" : "unknown"),
  };
}

test("normalizeAlias lowercases and hyphenates invalid characters", () => {
  assert.equal(normalizeAlias("  Foo Bar/Baz  "), "foo-bar-baz");
  assert.equal(normalizeAlias("***"), "---");
  assert.equal(normalizeAlias("   "), null);
});

test("getMatchingAccount prefers fingerprint over accountId", () => {
  const store = makeStore([
    makeAccount({ alias: "acc1", fingerprint: "fingerprint-1", accountId: "shared-account" }),
    makeAccount({ alias: "acc2", fingerprint: "fingerprint-2", accountId: "shared-account" }),
  ]);

  const match = getMatchingAccount(
    store,
    "fingerprint-2",
    "person@example.com",
    "shared-account",
    "pro",
  );

  assert.equal(match?.account.alias, "acc2");
  assert.equal(match?.reason, "fingerprint");
});

test("upsertAccount keeps same-accountId different-email accounts separate", () => {
  const store = makeStore([
    makeAccount({
      alias: "acc1",
      fingerprint: "fingerprint-1",
      accountId: "shared-account",
      email: "first@example.com",
    }),
  ]);

  const result = upsertAccount(
    store,
    makeAuth({
      fingerprint: "fingerprint-2",
      accountId: "shared-account",
      email: "second@example.com",
    }),
    "acc1",
  );

  assert.equal(result.created, true);
  assert.equal(result.alias, "acc2");
  assert.equal(store.accounts.length, 2);
});

test("matchesCanonicalAccountIdentity accepts same accountId when plan changes", () => {
  const account = makeAccount({
    alias: "acc1",
    accountId: "shared-account",
    email: "person@example.com",
    planType: "pro",
  });

  assert.equal(
    matchesCanonicalAccountIdentity(
      account,
      makeAuth({
        accountId: "shared-account",
        email: "person@example.com",
        planType: "team",
      }),
    ),
    true,
  );
});

test("matchesCanonicalAccountIdentity rejects reconnect when canonical accountId is missing", () => {
  const account = makeAccount({
    alias: "acc1",
    accountId: null,
    email: "person@example.com",
  });

  assert.equal(
    matchesCanonicalAccountIdentity(
      account,
      makeAuth({
        accountId: "shared-account",
        email: "person@example.com",
      }),
    ),
    false,
  );
});

test("matchesCanonicalAccountIdentity rejects a different account", () => {
  const account = makeAccount({
    alias: "acc1",
    accountId: "account-1",
    email: "first@example.com",
  });

  assert.equal(
    matchesCanonicalAccountIdentity(
      account,
      makeAuth({
        accountId: "account-2",
        email: "second@example.com",
      }),
    ),
    false,
  );
});

test("accountRequiresReconnect uses structured auth state instead of parsing error text", () => {
  assert.equal(
    accountRequiresReconnect(makeAccount({ usage: makeUsage({ error: "anything", authState: "reconnect-required" }) })),
    true,
  );
  assert.equal(
    accountRequiresReconnect(makeAccount({ usage: makeUsage({ error: "Token refresh failed (401)", authState: "unknown" }) })),
    false,
  );
  assert.equal(
    accountRequiresReconnect(makeAccount({ usage: makeUsage({ error: null, authState: "valid" }) })),
    false,
  );
});

test("selectRotationTarget prefers the healthiest non-current account", () => {
  const store = makeStore([
    makeAccount({
      alias: "acc1",
      usage: makeUsage({ primaryPercent: 5, weeklyPercent: 8 }),
    }),
    makeAccount({
      alias: "acc2",
      usage: makeUsage({ primaryPercent: 10, weeklyPercent: 12 }),
    }),
  ]);

  assert.deepEqual(selectRotationTarget(store, "acc1"), {
    alias: "acc2",
    recommendedAlias: "acc1",
    reason: "rotate",
    pool: "default",
  });
});

test("selectRotationTarget keeps current when it is the only healthy account", () => {
  const store = makeStore([
    makeAccount({
      alias: "acc1",
      usage: makeUsage({ primaryPercent: 5, weeklyPercent: 8 }),
    }),
    makeAccount({
      alias: "acc2",
      usage: makeUsage({ rateLimit: null, error: "Token refresh failed (401)" }),
    }),
  ]);

  assert.deepEqual(selectRotationTarget(store, "acc1"), {
    alias: "acc1",
    recommendedAlias: "acc1",
    reason: "keep-current",
    pool: "default",
  });
});

test("selectRotationTarget returns no eligible account when nothing healthy is stored", () => {
  const store = makeStore([
    makeAccount({
      alias: "acc1",
      usage: makeUsage({ rateLimit: null, error: "Usage request failed (500)" }),
    }),
  ]);

  assert.deepEqual(selectRotationTarget(store, null), {
    alias: null,
    recommendedAlias: null,
    reason: "no-eligible-account",
    pool: null,
  });
});

test("recommendedAlias and selectRotationTarget respect preferred and reserve tiers", () => {
  const store = makeStore([
    makeAccount({ alias: "biz1", usage: makeUsage({ primaryPercent: 70, weeklyPercent: 82 }) }),
    makeAccount({ alias: "biz2", usage: makeUsage({ primaryPercent: 72, weeklyPercent: 88 }) }),
    makeAccount({ alias: "pro1", usage: makeUsage({ primaryPercent: 10, weeklyPercent: 20 }) }),
  ]);
  store.rotationPolicy = {
    preferredAliases: ["biz1", "biz2"],
    reserveAliases: ["pro1"],
    heavyRun: {
      maxPrimaryUsedPercent: 60,
      maxWeeklyUsedPercent: 80,
    },
  };

  assert.equal(recommendedAlias(store), "pro1");
  assert.deepEqual(selectRotationTarget(store, "biz1"), {
    alias: "pro1",
    recommendedAlias: "pro1",
    reason: "fallback",
    pool: "reserve",
  });
});
