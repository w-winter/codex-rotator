import { OPENAI_AUTH_BASE_URL, OPENAI_OAUTH_CLIENT_ID, OPENAI_USAGE_URL } from "./config.js";
import { applyTokenRefresh, readStoredTokens } from "./auth-file.js";
import type {
  CreditsRecord,
  RateLimitRecord,
  StoredAccount,
  TokenRefreshResult,
  UsageRecord,
  UsageWindowRecord,
} from "./types.js";

type RawWindow = {
  used_percent?: number | null;
  limit_window_seconds?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
};

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
  const value = claims?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapWindow(window: RawWindow | null | undefined): UsageWindowRecord | null {
  if (!window) return null;
  return {
    usedPercent: typeof window.used_percent === "number" ? window.used_percent : null,
    limitWindowSeconds:
      typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : null,
    resetAfterSeconds:
      typeof window.reset_after_seconds === "number" ? window.reset_after_seconds : null,
    resetAt: typeof window.reset_at === "number" ? window.reset_at : null,
  };
}

function mapRateLimit(input: unknown): RateLimitRecord | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  return {
    allowed: source.allowed !== false,
    limitReached: source.limit_reached === true,
    primaryWindow: mapWindow((source.primary_window as RawWindow | undefined) ?? null),
    secondaryWindow: mapWindow((source.secondary_window as RawWindow | undefined) ?? null),
  };
}

function mapCredits(input: unknown): CreditsRecord | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  return {
    hasCredits: source.has_credits === true,
    unlimited: source.unlimited === true,
    balance: typeof source.balance === "string" ? source.balance : null,
    approxLocalMessages:
      typeof source.approx_local_messages === "number" ? source.approx_local_messages : null,
    approxCloudMessages:
      typeof source.approx_cloud_messages === "number" ? source.approx_cloud_messages : null,
  };
}

function extractRefreshMetadata(idToken: string, accessToken: string) {
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const authClaims =
    ((idClaims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined) ??
      (accessClaims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined)) ||
    null;

  const exp =
    (typeof idClaims?.exp === "number" ? idClaims.exp : null) ??
    (typeof accessClaims?.exp === "number" ? accessClaims.exp : null);

  return {
    accountId:
      (typeof authClaims?.chatgpt_account_id === "string" ? authClaims.chatgpt_account_id : null) ||
      claimString(idClaims, "chatgpt_account_id") ||
      null,
    email: claimString(idClaims, "email") || claimString(accessClaims, "email") || null,
    planType:
      (typeof authClaims?.chatgpt_plan_type === "string" ? authClaims.chatgpt_plan_type : null) ||
      claimString(idClaims, "chatgpt_plan_type") ||
      null,
    tokenExpiresAt: typeof exp === "number" ? new Date(exp * 1000).toISOString() : null,
  };
}

async function fetchUserInfoEmail(accessToken: string) {
  try {
    const response = await fetch(`${OPENAI_AUTH_BASE_URL}/userinfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return typeof payload?.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  redirectUri,
}: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenRefreshResult> {
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new Error(
      `OAuth token exchange failed (${response.status})${payload && typeof payload.error_description === "string" ? `: ${payload.error_description}` : ""}`,
    );
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : null;

  if (!accessToken || !refreshToken || !idToken) {
    throw new Error("OAuth token exchange did not return a full token bundle");
  }

  const metadata = extractRefreshMetadata(idToken, accessToken);
  const email = metadata.email ?? (await fetchUserInfoEmail(accessToken));

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: metadata.accountId,
    email,
    planType: metadata.planType,
    tokenExpiresAt: metadata.tokenExpiresAt,
  };
}

export async function refreshStoredAccount(account: StoredAccount) {
  const { refreshToken } = readStoredTokens(account);
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: OPENAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new Error(
      `Token refresh failed (${response.status})${payload && typeof payload.error_description === "string" ? `: ${payload.error_description}` : ""}`,
    );
  }

  const accessToken =
    typeof payload.access_token === "string" ? payload.access_token : null;
  const nextRefreshToken =
    typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : null;

  if (!accessToken || !nextRefreshToken || !idToken) {
    throw new Error("Token refresh response did not include a full token bundle");
  }

  const metadata = extractRefreshMetadata(idToken, accessToken);

  const result: TokenRefreshResult = {
    accessToken,
    refreshToken: nextRefreshToken,
    idToken,
    accountId: metadata.accountId,
    email: metadata.email,
    planType: metadata.planType,
    tokenExpiresAt: metadata.tokenExpiresAt,
  };

  applyTokenRefresh(account, result);
}

export async function fetchUsageForAccount(account: StoredAccount): Promise<UsageRecord> {
  const { accessToken, accountId } = readStoredTokens(account);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-auth-switcher",
  };

  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const response = await fetch(OPENAI_USAGE_URL, { headers });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok || !payload) {
    throw new Error(`Usage request failed (${response.status})`);
  }

  const nowIso = new Date().toISOString();
  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : account.planType,
    rateLimit: mapRateLimit(payload.rate_limit),
    codeReviewRateLimit: mapRateLimit(payload.code_review_rate_limit),
    credits: mapCredits(payload.credits),
    fetchedAt: nowIso,
    error: null,
  };
}
