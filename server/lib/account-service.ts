import { readCurrentAuthFile, writeCurrentAuthFile } from "./auth-file.js";
import {
  getMatchingAccount,
  matchesCanonicalAccountIdentity,
  nextAlias,
  normalizeAlias,
  rotationPolicyAliases,
  selectRotationTarget,
  syncStoredAccount,
  upsertAccount,
} from "./accounts.js";
import { MAX_PARALLEL_ACCOUNT_REFRESH } from "./config.js";
import { toDashboardState } from "./dashboard-state.js";
import { MutationLockBusyError, withMutationLock } from "./mutation-lock.js";
import { OpenAiRequestError, fetchUsageForAccount, refreshStoredAccount } from "./openai.js";
import { createDefaultRotationPolicy, loadStore, saveStore } from "./store.js";
import type { ExtractedAuth, RotationPolicy, StoredAccount, StoreFile, UsageRecord } from "./types.js";

export type AccountServiceErrorCode =
  | "INVALID_ALIAS"
  | "INVALID_POLICY"
  | "ALIAS_CONFLICT"
  | "ACCOUNT_NOT_FOUND"
  | "NO_MATCHING_ACCOUNTS"
  | "OPERATION_IN_PROGRESS"
  | "REAUTH_ACCOUNT_MISMATCH";

export class AccountServiceError extends Error {
  code: AccountServiceErrorCode;

  constructor(code: AccountServiceErrorCode, message: string) {
    super(message);
    this.name = "AccountServiceError";
    this.code = code;
  }
}

export type LimitRefreshProgress = {
  total: number;
  completed: number;
  alias: string;
  ok: boolean;
  message: string | null;
};

type UsageRefreshResult = {
  ok: boolean;
  message: string | null;
};

function normalizeOptionalAlias(input: string | null | undefined) {
  const normalized = normalizeAlias(input);
  if ((input ?? "").trim().length > 0 && !normalized) {
    throw new AccountServiceError("INVALID_ALIAS", "Alias is invalid");
  }
  return normalized;
}

function requireAlias(input: string | null | undefined) {
  const normalized = normalizeOptionalAlias(input);
  if (!normalized) {
    throw new AccountServiceError("INVALID_ALIAS", "Alias is required");
  }
  return normalized;
}

function normalizeAliasList(input: string[] | null | undefined) {
  if (input == null) {
    return null;
  }

  return input.map((alias) => requireAlias(alias));
}

function requirePercent(value: number | null | undefined, name: string) {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new AccountServiceError("INVALID_POLICY", `${name} must be a number between 0 and 100`);
  }

  return value;
}

function validateRotationPolicy(store: StoreFile, policy: RotationPolicy) {
  const duplicatePreferred = policy.preferredAliases.filter(
    (alias, index, aliases) => aliases.indexOf(alias) !== index,
  );
  const duplicateReserve = policy.reserveAliases.filter(
    (alias, index, aliases) => aliases.indexOf(alias) !== index,
  );
  const duplicates = [...new Set([...duplicatePreferred, ...duplicateReserve])];
  if (duplicates.length > 0) {
    throw new AccountServiceError(
      "INVALID_POLICY",
      `Rotation policy contains duplicate aliases: ${duplicates.join(", ")}`,
    );
  }

  const overlap = policy.preferredAliases.filter((alias) => policy.reserveAliases.includes(alias));
  if (overlap.length > 0) {
    throw new AccountServiceError(
      "INVALID_POLICY",
      `Aliases cannot be both preferred and reserve: ${overlap.join(", ")}`,
    );
  }

  const knownAliases = new Set(store.accounts.map((account) => account.alias));
  const missingAliases = rotationPolicyAliases(policy).filter((alias) => !knownAliases.has(alias));
  if (missingAliases.length > 0) {
    throw new AccountServiceError(
      "ACCOUNT_NOT_FOUND",
      `Rotation policy references unknown aliases: ${missingAliases.join(", ")}`,
    );
  }

  requirePercent(policy.heavyRun.maxPrimaryUsedPercent, "maxPrimaryUsedPercent");
  requirePercent(policy.heavyRun.maxWeeklyUsedPercent, "maxWeeklyUsedPercent");
}

function mapLockError(error: unknown): never {
  if (error instanceof MutationLockBusyError) {
    throw new AccountServiceError("OPERATION_IN_PROGRESS", error.message);
  }

  throw error;
}

async function withServiceMutationLock<T>(label: string, task: () => Promise<T>) {
  try {
    return await withMutationLock(label, task);
  } catch (error) {
    mapLockError(error);
  }
}

function buildFailedUsage(
  account: StoredAccount,
  message: string,
  authState: UsageRecord["authState"],
): UsageRecord {
  return {
    planType: account.planType,
    rateLimit: account.usage?.rateLimit ?? null,
    codeReviewRateLimit: account.usage?.codeReviewRateLimit ?? null,
    credits: account.usage?.credits ?? null,
    fetchedAt: new Date().toISOString(),
    error: message,
    authState,
  };
}

function applyUsage(account: StoredAccount, usage: UsageRecord) {
  account.usage = usage;
  account.lastLimitRefreshAt = usage.fetchedAt;
  account.planType = usage.planType ?? account.planType;
}

async function refreshUsageWithAutoTokenRefresh(account: StoredAccount): Promise<UsageRefreshResult> {
  try {
    applyUsage(account, await fetchUsageForAccount(account));
    return { ok: true, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Usage refresh failed";
    const shouldRetry =
      error instanceof OpenAiRequestError
      && error.operation === "usage"
      && (error.status === 401 || error.status === 403);

    if (shouldRetry) {
      try {
        await refreshStoredAccount(account);
        applyUsage(account, await fetchUsageForAccount(account));
        return { ok: true, message: null };
      } catch (retryError) {
        const retryMessage =
          retryError instanceof Error ? retryError.message : "Usage refresh failed after token refresh";
        const authState =
          retryError instanceof OpenAiRequestError
          && retryError.operation === "token-refresh"
          && (retryError.status === 401 || retryError.status === 403)
            ? "reconnect-required"
            : "unknown";
        applyUsage(account, buildFailedUsage(account, retryMessage, authState));
        return { ok: false, message: retryMessage };
      }
    }

    applyUsage(account, buildFailedUsage(account, message, "unknown"));
    return { ok: false, message };
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex]!);
    }
  });

  await Promise.all(runners);
}

function findAccountByAlias(store: StoreFile, alias: string) {
  const account = store.accounts.find((item) => item.alias === alias);
  if (!account) {
    throw new AccountServiceError("ACCOUNT_NOT_FOUND", "Account not found");
  }
  return account;
}

function selectTargetAccounts(store: StoreFile, alias: string | null) {
  if (alias) {
    return [findAccountByAlias(store, alias)];
  }

  if (store.accounts.length === 0) {
    throw new AccountServiceError("NO_MATCHING_ACCOUNTS", "No matching accounts found");
  }

  return [...store.accounts];
}

export async function resolveCurrentAuth() {
  try {
    return await readCurrentAuthFile();
  } catch {
    return null;
  }
}

export async function readDashboardState() {
  const store = await loadStore();
  const currentAuth = await resolveCurrentAuth();
  return toDashboardState(store, currentAuth);
}

export async function readRotationPolicy() {
  const store = await loadStore();
  return { policy: store.rotationPolicy, accounts: store.accounts.map((account) => account.alias) };
}

export async function updateRotationPolicy(options: {
  preferredAliases?: string[] | null;
  reserveAliases?: string[] | null;
  maxPrimaryUsedPercent?: number | null;
  maxWeeklyUsedPercent?: number | null;
}) {
  return withServiceMutationLock("update-rotation-policy", async () => {
    const store = await loadStore();
    const nextPolicy: RotationPolicy = {
      preferredAliases: normalizeAliasList(options.preferredAliases) ?? store.rotationPolicy.preferredAliases,
      reserveAliases: normalizeAliasList(options.reserveAliases) ?? store.rotationPolicy.reserveAliases,
      heavyRun: {
        maxPrimaryUsedPercent:
          options.maxPrimaryUsedPercent ?? store.rotationPolicy.heavyRun.maxPrimaryUsedPercent,
        maxWeeklyUsedPercent:
          options.maxWeeklyUsedPercent ?? store.rotationPolicy.heavyRun.maxWeeklyUsedPercent,
      },
    };

    validateRotationPolicy(store, nextPolicy);
    store.rotationPolicy = nextPolicy;
    await saveStore(store);
    return { store, policy: store.rotationPolicy };
  });
}

export async function clearRotationPolicy() {
  return withServiceMutationLock("clear-rotation-policy", async () => {
    const store = await loadStore();
    store.rotationPolicy = createDefaultRotationPolicy();
    await saveStore(store);
    return { store, policy: store.rotationPolicy };
  });
}

export async function syncCurrentDeviceAuth(options?: { preferredAlias?: string | null }) {
  const preferredAlias = normalizeOptionalAlias(options?.preferredAlias);

  return withServiceMutationLock("sync-current-device-auth", async () => {
    const currentAuth = await readCurrentAuthFile();
    const store = await loadStore();
    const matched = getMatchingAccount(
      store,
      currentAuth.fingerprint,
      currentAuth.email,
      currentAuth.accountId,
      currentAuth.planType,
    );

    if (
      preferredAlias &&
      !matched?.account &&
      store.accounts.some((account) => account.alias === preferredAlias)
    ) {
      throw new AccountServiceError("ALIAS_CONFLICT", `Alias '${preferredAlias}' is already in use`);
    }

    const alias = preferredAlias ?? matched?.account.alias ?? nextAlias(store);
    const result = upsertAccount(store, currentAuth, alias);
    await refreshUsageWithAutoTokenRefresh(result.account);
    await saveStore(store);

    return {
      store,
      currentAuth,
      account: result.account,
      created: result.created,
      alias: result.alias,
      matchReason: result.matchReason,
    };
  });
}

export async function storeExtractedAccount(options: {
  auth: ExtractedAuth;
  preferredAlias: string;
  preserveExistingAlias?: boolean;
}) {
  const preferredAlias = requireAlias(options.preferredAlias);

  return withServiceMutationLock(`store-extracted-account:${preferredAlias}`, async () => {
    const store = await loadStore();
    const result = upsertAccount(store, options.auth, preferredAlias, {
      preserveExistingAlias: options.preserveExistingAlias,
    });
    await refreshUsageWithAutoTokenRefresh(result.account);
    await saveStore(store);

    return {
      store,
      account: result.account,
      created: result.created,
      alias: result.alias,
      matchReason: result.matchReason,
    };
  });
}

export async function reconnectStoredAccount(options: { alias: string; auth: ExtractedAuth }) {
  const alias = requireAlias(options.alias);

  return withServiceMutationLock(`reconnect-account:${alias}`, async () => {
    const store = await loadStore();
    const account = findAccountByAlias(store, alias);
    const match = getMatchingAccount(
      store,
      options.auth.fingerprint,
      options.auth.email,
      options.auth.accountId,
      options.auth.planType,
    );

    if (match && match.account.alias !== alias) {
      throw new AccountServiceError(
        "REAUTH_ACCOUNT_MISMATCH",
        `OAuth login matched stored account '${match.account.alias}', not '${alias}'. Use Add account if you intended a different account.`,
      );
    }

    if (!matchesCanonicalAccountIdentity(account, options.auth)) {
      throw new AccountServiceError(
        "REAUTH_ACCOUNT_MISMATCH",
        `The OAuth login did not match stored account '${alias}'. Use Add account if you intended a different account.`,
      );
    }

    syncStoredAccount(account, options.auth, account.alias);
    store.lastSyncedAt = account.lastSyncedAt;
    await refreshUsageWithAutoTokenRefresh(account);
    await saveStore(store);

    return {
      store,
      account,
      alias: account.alias,
      created: false,
      matchReason: match?.reason ?? null,
    };
  });
}

export async function activateAccountOnDevice(aliasInput: string) {
  const alias = requireAlias(aliasInput);

  return withServiceMutationLock(`activate-account:${alias}`, async () => {
    const store = await loadStore();
    const account = findAccountByAlias(store, alias);
    await writeCurrentAuthFile(account.rawAuth);
    account.usageCount += 1;
    await saveStore(store);

    return { store, account };
  });
}

export async function rotateAccountOnDevice() {
  return withServiceMutationLock("rotate-account", async () => {
    const store = await loadStore();
    const currentAuth = await resolveCurrentAuth();
    const currentAlias = currentAuth
      ? getMatchingAccount(
          store,
          currentAuth.fingerprint,
          currentAuth.email,
          currentAuth.accountId,
          currentAuth.planType,
        )?.account.alias ?? null
      : null;
    const decision = selectRotationTarget(store, currentAlias);

    if (!decision.alias) {
      return {
        store,
        currentAlias,
        previousAlias: currentAlias,
        selectedAlias: null,
        recommendedAlias: decision.recommendedAlias,
        reason: decision.reason,
        pool: decision.pool,
        changed: false,
        account: null,
      };
    }

    const account = findAccountByAlias(store, decision.alias);
    const changed = decision.alias !== currentAlias;

    if (changed) {
      await writeCurrentAuthFile(account.rawAuth);
      account.usageCount += 1;
      await saveStore(store);
    }

    return {
      store,
      currentAlias: changed ? decision.alias : currentAlias,
      previousAlias: currentAlias,
      selectedAlias: decision.alias,
      recommendedAlias: decision.recommendedAlias,
      reason: decision.reason,
      pool: decision.pool,
      changed,
      account,
    };
  });
}

export async function refreshAccountTokens(options?: { alias?: string | null }) {
  const alias = normalizeOptionalAlias(options?.alias);

  return withServiceMutationLock(alias ? `refresh-tokens:${alias}` : "refresh-tokens:all", async () => {
    const store = await loadStore();
    const targets = selectTargetAccounts(store, alias);

    await runWithConcurrency(targets, MAX_PARALLEL_ACCOUNT_REFRESH, async (account) => {
      await refreshStoredAccount(account);
    });

    await saveStore(store);
    return { store, refreshedAliases: targets.map((account) => account.alias) };
  });
}

export async function refreshAccountLimits(options?: {
  alias?: string | null;
  onProgress?: (event: LimitRefreshProgress) => void | Promise<void>;
}) {
  const alias = normalizeOptionalAlias(options?.alias);

  return withServiceMutationLock(alias ? `refresh-limits:${alias}` : "refresh-limits:all", async () => {
    const store = await loadStore();
    const targets = selectTargetAccounts(store, alias);
    let completed = 0;
    let failed = 0;
    const errors: Array<{ alias: string; message: string }> = [];
    let saveQueue = Promise.resolve();

    const queueSave = () => {
      saveQueue = saveQueue.then(async () => {
        store.lastSyncedAt = new Date().toISOString();
        await saveStore(store);
      });
      return saveQueue;
    };

    await runWithConcurrency(targets, MAX_PARALLEL_ACCOUNT_REFRESH, async (account) => {
      const result = await refreshUsageWithAutoTokenRefresh(account);
      completed += 1;

      if (!result.ok) {
        failed += 1;
        errors.push({
          alias: account.alias,
          message: result.message ?? "Limit refresh failed",
        });
      }

      await queueSave();
      await options?.onProgress?.({
        total: targets.length,
        completed,
        alias: account.alias,
        ok: result.ok,
        message: result.message,
      });
    });

    await saveQueue;
    return {
      store,
      total: targets.length,
      completed,
      failed,
      errors,
      refreshedAliases: targets.map((account) => account.alias),
    };
  });
}

export async function deleteStoredAccount(aliasInput: string) {
  const alias = requireAlias(aliasInput);

  return withServiceMutationLock(`delete-account:${alias}`, async () => {
    const store = await loadStore();
    const accountIndex = store.accounts.findIndex((account) => account.alias === alias);

    if (accountIndex === -1) {
      throw new AccountServiceError("ACCOUNT_NOT_FOUND", "Account not found");
    }

    store.accounts.splice(accountIndex, 1);
    await saveStore(store);
    return { store };
  });
}
