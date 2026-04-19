export type RawAuthJson = Record<string, unknown>;

export type UsageWindowRecord = {
  usedPercent: number | null;
  limitWindowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
};

export type RateLimitRecord = {
  allowed: boolean;
  limitReached: boolean;
  primaryWindow: UsageWindowRecord | null;
  secondaryWindow: UsageWindowRecord | null;
};

export type CreditsRecord = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
  approxLocalMessages: number | null;
  approxCloudMessages: number | null;
};

export type UsageAuthState = "valid" | "unknown" | "reconnect-required";

export type UsageRecord = {
  planType: string | null;
  rateLimit: RateLimitRecord | null;
  codeReviewRateLimit: RateLimitRecord | null;
  credits: CreditsRecord | null;
  fetchedAt: string | null;
  error: string | null;
  authState: UsageAuthState;
};

export type StoredAccount = {
  alias: string;
  fingerprint: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  tokenExpiresAt: string | null;
  lastSyncedAt: string;
  lastTokenRefreshAt: string | null;
  lastLimitRefreshAt: string | null;
  usageCount: number;
  rawAuth: RawAuthJson;
  usage: UsageRecord | null;
};

export type RotationPolicy = {
  preferredAliases: string[];
  reserveAliases: string[];
  heavyRun: {
    maxPrimaryUsedPercent: number;
    maxWeeklyUsedPercent: number;
  };
};

export type StoreFile = {
  version: 1;
  thresholds: {
    notifyPercent: number;
  };
  rotationPolicy: RotationPolicy;
  lastSyncedAt: string | null;
  accounts: StoredAccount[];
};

export type ExtractedAuth = {
  rawAuth: RawAuthJson;
  fingerprint: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  tokenExpiresAt: string | null;
  accessToken: string;
  refreshToken: string;
  idToken: string;
};

export type TokenRefreshResult = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string | null;
  email: string | null;
  planType: string | null;
  tokenExpiresAt: string | null;
};
