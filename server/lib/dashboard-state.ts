import { getMatchingAccount, recommendedAlias, sortAccountsForDisplay } from "./accounts.js";
import { CODEX_AUTH_PATH, STORE_PATH } from "./config.js";
import type { ExtractedAuth, StoreFile, StoredAccount } from "./types.js";

export type DashboardAccountState = {
  alias: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
  lastTokenRefreshAt: string | null;
  lastLimitRefreshAt: string | null;
  onDevice: boolean;
  recommended: boolean;
  usageCount: number;
  usage: StoredAccount["usage"];
};

export type DashboardState = {
  authPath: string;
  storePath: string;
  storeEncrypted: boolean;
  currentAlias: string | null;
  recommendedAlias: string | null;
  currentAuthKnown: boolean;
  lastSyncedAt: string | null;
  thresholds: StoreFile["thresholds"];
  accounts: DashboardAccountState[];
};

export function toDashboardState(store: StoreFile, currentAuth: ExtractedAuth | null): DashboardState {
  const currentAccount = currentAuth
    ? getMatchingAccount(
        store,
        currentAuth.fingerprint,
        currentAuth.email,
        currentAuth.accountId,
        currentAuth.planType,
      )?.account ?? null
    : null;
  const recommended = recommendedAlias(store);

  return {
    authPath: CODEX_AUTH_PATH,
    storePath: STORE_PATH,
    storeEncrypted: true,
    currentAlias: currentAccount?.alias ?? null,
    recommendedAlias: recommended,
    currentAuthKnown: Boolean(currentAccount),
    lastSyncedAt: store.lastSyncedAt,
    thresholds: store.thresholds,
    accounts: sortAccountsForDisplay(store.accounts, currentAccount?.alias ?? null).map((account) => ({
      alias: account.alias,
      email: account.email,
      accountId: account.accountId,
      planType: account.planType,
      tokenExpiresAt: account.tokenExpiresAt,
      lastSyncedAt: account.lastSyncedAt,
      lastTokenRefreshAt: account.lastTokenRefreshAt,
      lastLimitRefreshAt: account.lastLimitRefreshAt,
      onDevice: currentAccount?.alias === account.alias,
      recommended: account.alias === recommended,
      usageCount: account.usageCount,
      usage: account.usage,
    })),
  };
}
