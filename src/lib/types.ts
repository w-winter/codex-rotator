export type LimitWindow = {
  usedPercent: number | null;
  limitWindowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
};

export type RateLimitSummary = {
  allowed: boolean;
  limitReached: boolean;
  primaryWindow: LimitWindow | null;
  secondaryWindow: LimitWindow | null;
};

export type CreditsSummary = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
  approxLocalMessages: number | null;
  approxCloudMessages: number | null;
};

export type UsageSummary = {
  planType: string | null;
  rateLimit: RateLimitSummary | null;
  codeReviewRateLimit: RateLimitSummary | null;
  credits: CreditsSummary | null;
  fetchedAt: string | null;
  error: string | null;
};

export type AccountSummary = {
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
  usage: UsageSummary | null;
};

export type DashboardState = {
  authPath: string;
  storePath: string;
  storeEncrypted: boolean;
  currentAlias: string | null;
  recommendedAlias: string | null;
  currentAuthKnown: boolean;
  lastSyncedAt: string | null;
  thresholds: {
    notifyPercent: number;
  };
  accounts: AccountSummary[];
};

export type SyncCurrentResponse = {
  account: AccountSummary;
  created: boolean;
};

export type LimitRefreshJob = {
  jobId: string;
  status: "running" | "completed";
  total: number;
  completed: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  errors: Array<{
    alias: string;
    message: string;
  }>;
};

export type OauthFlowStartResponse = {
  flowId: string;
  alias: string;
  authorizationUrl: string;
  status: "pending" | "success" | "error";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  accountAlias: string | null;
  email: string | null;
  created: boolean | null;
  matchReason: "fingerprint" | "accountId" | null;
};

export type OauthFlowStatusResponse = OauthFlowStartResponse;
