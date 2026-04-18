import { buildStoredAccount } from "./auth-file.js";
import type { ExtractedAuth, RotationPolicy, StoredAccount, StoreFile } from "./types.js";

export type AccountMatchReason = "fingerprint" | "accountId";
export type RotationDecisionReason =
  | "recommended"
  | "rotate"
  | "fallback"
  | "keep-current"
  | "no-eligible-account";
export type RotationDecisionPool = "default" | "preferred" | "reserve" | null;

export function normalizeAlias(input: string | null | undefined) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return normalized.length > 0 ? normalized : null;
}

export function getMatchingAccount(
  store: StoreFile,
  fingerprint: string,
  email: string | null,
  accountId: string | null,
  planType: string | null,
) {
  const fingerprintMatch = store.accounts.find((account) => account.fingerprint === fingerprint);
  if (fingerprintMatch) {
    return { account: fingerprintMatch, reason: "fingerprint" as const };
  }

  const ambiguousAccountIdMatch = store.accounts.find(
    (account) =>
      account.accountId &&
      accountId &&
      account.accountId === accountId &&
      account.email &&
      email &&
      account.email !== email,
  );
  if (ambiguousAccountIdMatch) {
    console.warn(
      "[codex-auth-switcher] accountId collision detected across different emails",
      JSON.stringify({
        accountId,
        existingAlias: ambiguousAccountIdMatch.alias,
        existingEmail: ambiguousAccountIdMatch.email,
        incomingEmail: email,
      }),
    );
  }

  const accountIdMatch = store.accounts.find(
    (account) =>
      account.accountId &&
      accountId &&
      account.accountId === accountId &&
      (!account.email || !email || account.email === email) &&
      (!account.planType || !planType || account.planType === planType),
  );
  if (accountIdMatch) {
    return { account: accountIdMatch, reason: "accountId" as const };
  }

  return null;
}

export function nextAlias(store: StoreFile) {
  let index = 1;
  while (store.accounts.some((account) => account.alias === `acc${index}`)) {
    index += 1;
  }
  return `acc${index}`;
}

export function syncStoredAccount(existing: StoredAccount, auth: ExtractedAuth, alias: string) {
  existing.alias = alias;
  existing.fingerprint = auth.fingerprint;
  existing.email = auth.email;
  existing.accountId = auth.accountId;
  existing.planType = auth.planType;
  existing.tokenExpiresAt = auth.tokenExpiresAt;
  existing.rawAuth = auth.rawAuth;
  existing.lastSyncedAt = new Date().toISOString();
  return existing;
}

export function resolveAvailableAlias(
  store: StoreFile,
  preferredAlias: string,
  currentAlias?: string | null,
) {
  if (
    !store.accounts.some(
      (account) => account.alias === preferredAlias && account.alias !== currentAlias,
    )
  ) {
    return preferredAlias;
  }

  return nextAlias(store);
}

export function upsertAccount(
  store: StoreFile,
  auth: ExtractedAuth,
  preferredAlias: string,
  options?: { preserveExistingAlias?: boolean },
) {
  const match = getMatchingAccount(store, auth.fingerprint, auth.email, auth.accountId, auth.planType);
  const existing = match?.account ?? null;

  if (existing) {
    const alias = options?.preserveExistingAlias
      ? existing.alias
      : resolveAvailableAlias(store, preferredAlias, existing.alias);
    const account = syncStoredAccount(existing, auth, alias);
    store.lastSyncedAt = account.lastSyncedAt;
    return { account, created: false, alias, matchReason: match?.reason ?? null };
  }

  const alias = resolveAvailableAlias(store, preferredAlias);
  const account = buildStoredAccount(auth, alias);
  store.accounts.push(account);
  store.lastSyncedAt = account.lastSyncedAt;
  return { account, created: true, alias, matchReason: null };
}

export function sortByRecommendation(accounts: StoredAccount[]) {
  return [...accounts].sort((left, right) => {
    const leftWeekly = left.usage?.rateLimit?.secondaryWindow?.usedPercent ?? 999;
    const rightWeekly = right.usage?.rateLimit?.secondaryWindow?.usedPercent ?? 999;
    if (leftWeekly !== rightWeekly) return leftWeekly - rightWeekly;

    const leftPrimary = left.usage?.rateLimit?.primaryWindow?.usedPercent ?? 999;
    const rightPrimary = right.usage?.rateLimit?.primaryWindow?.usedPercent ?? 999;
    if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;

    return left.alias.localeCompare(right.alias);
  });
}

export function sortAccountsForDisplay(accounts: StoredAccount[], currentAlias: string | null) {
  return [...accounts].sort((left, right) => {
    const leftCurrent = currentAlias != null && left.alias === currentAlias;
    const rightCurrent = currentAlias != null && right.alias === currentAlias;
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? -1 : 1;
    }

    const leftWeekly = left.usage?.rateLimit?.secondaryWindow?.usedPercent ?? 999;
    const rightWeekly = right.usage?.rateLimit?.secondaryWindow?.usedPercent ?? 999;
    if (leftWeekly !== rightWeekly) return leftWeekly - rightWeekly;

    const leftPrimary = left.usage?.rateLimit?.primaryWindow?.usedPercent ?? 999;
    const rightPrimary = right.usage?.rateLimit?.primaryWindow?.usedPercent ?? 999;
    if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;

    return left.alias.localeCompare(right.alias);
  });
}

function hasManagedRotationPolicy(policy: RotationPolicy) {
  return policy.preferredAliases.length > 0 || policy.reserveAliases.length > 0;
}

function isEligibleForHeavyRun(account: StoredAccount, policy: RotationPolicy) {
  const primaryUsedPercent = account.usage?.rateLimit?.primaryWindow?.usedPercent ?? null;
  const weeklyUsedPercent = account.usage?.rateLimit?.secondaryWindow?.usedPercent ?? null;

  return (
    account.usage != null &&
    account.usage.error == null &&
    primaryUsedPercent != null &&
    weeklyUsedPercent != null &&
    primaryUsedPercent <= policy.heavyRun.maxPrimaryUsedPercent &&
    weeklyUsedPercent <= policy.heavyRun.maxWeeklyUsedPercent
  );
}

function filterEligibleAliases(
  store: StoreFile,
  aliases: string[] | null,
) {
  const eligibleAccounts = store.accounts.filter((account) => isEligibleForHeavyRun(account, store.rotationPolicy));
  if (aliases == null) {
    return sortByRecommendation(eligibleAccounts);
  }

  const aliasSet = new Set(aliases);
  return sortByRecommendation(eligibleAccounts.filter((account) => aliasSet.has(account.alias)));
}

function chooseFromPool(
  accounts: StoredAccount[],
  currentAlias: string | null,
  pool: Exclude<RotationDecisionPool, null>,
) {
  const recommended = accounts[0] ?? null;
  if (!recommended) {
    return {
      alias: null,
      recommendedAlias: null,
      reason: "no-eligible-account" as const,
      pool: null,
    };
  }

  if (currentAlias == null) {
    return {
      alias: recommended.alias,
      recommendedAlias: recommended.alias,
      reason: pool === "reserve" ? "fallback" as const : "recommended" as const,
      pool,
    };
  }

  if (recommended.alias !== currentAlias) {
    return {
      alias: recommended.alias,
      recommendedAlias: recommended.alias,
      reason: pool === "reserve" ? "fallback" as const : "recommended" as const,
      pool,
    };
  }

  const alternate = accounts.find((account) => account.alias !== currentAlias) ?? null;
  if (alternate) {
    return {
      alias: alternate.alias,
      recommendedAlias: recommended.alias,
      reason: pool === "reserve" ? "fallback" as const : "rotate" as const,
      pool,
    };
  }

  return {
    alias: currentAlias,
    recommendedAlias: recommended.alias,
    reason: "keep-current" as const,
    pool,
  };
}

export function recommendedAlias(store: StoreFile) {
  const preferred = filterEligibleAliases(
    store,
    hasManagedRotationPolicy(store.rotationPolicy) ? store.rotationPolicy.preferredAliases : null,
  );
  if (preferred.length > 0) {
    return preferred[0]?.alias ?? null;
  }

  if (!hasManagedRotationPolicy(store.rotationPolicy)) {
    return null;
  }

  return filterEligibleAliases(store, store.rotationPolicy.reserveAliases)[0]?.alias ?? null;
}

export function rotationPolicyAliases(policy: RotationPolicy) {
  return [...new Set([...policy.preferredAliases, ...policy.reserveAliases])];
}

export function selectRotationTarget(store: StoreFile, currentAlias: string | null) {
  if (!hasManagedRotationPolicy(store.rotationPolicy)) {
    const candidates = filterEligibleAliases(store, null);
    return chooseFromPool(candidates, currentAlias, "default");
  }

  const preferred = filterEligibleAliases(store, store.rotationPolicy.preferredAliases);
  if (preferred.length > 0) {
    return chooseFromPool(preferred, currentAlias, "preferred");
  }

  const reserve = filterEligibleAliases(store, store.rotationPolicy.reserveAliases);
  if (reserve.length > 0) {
    return chooseFromPool(reserve, currentAlias, "reserve");
  }

  return {
    alias: null,
    recommendedAlias: null,
    reason: "no-eligible-account" as const,
    pool: null,
  };
}
