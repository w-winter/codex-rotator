import express from "express";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import {
  buildExtractedAuthFromTokens,
  buildStoredAccount,
  readCurrentAuthFile,
  writeCurrentAuthFile,
} from "./lib/auth-file.js";
import {
  CODEX_AUTH_PATH,
  MAX_PARALLEL_ACCOUNT_REFRESH,
  OPENAI_OAUTH_CALLBACK_PORT,
  SERVER_HOST,
  SERVER_PORT,
  STORE_PATH,
} from "./lib/config.js";
import {
  findOauthFlowByState,
  getOauthFlow,
  hasPendingOauthFlows,
  markOauthFlowError,
  markOauthFlowSuccess,
  startOauthFlow,
} from "./lib/oauth.js";
import {
  exchangeAuthorizationCode,
  fetchUsageForAccount,
  refreshStoredAccount,
} from "./lib/openai.js";
import { localOnlyMiddleware } from "./lib/security.js";
import { loadStore, saveStore } from "./lib/store.js";
import type { ExtractedAuth, StoredAccount, StoreFile, UsageRecord } from "./lib/types.js";

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const distDir = path.resolve(process.cwd(), "dist");
let oauthCallbackListener: HttpServer | null = null;
let oauthCallbackListenerPromise: Promise<void> | null = null;
type LimitRefreshJob = {
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

const limitRefreshJobs = new Map<string, LimitRefreshJob>();
let activeLimitRefreshJobId: string | null = null;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(localOnlyMiddleware);

function toPublicLimitRefreshJob(job: LimitRefreshJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errors: job.errors,
  };
}

function pruneLimitRefreshJobs() {
  if (limitRefreshJobs.size <= 10) return;

  const completedJobs = [...limitRefreshJobs.values()]
    .filter((job) => job.status === "completed")
    .sort((left, right) => {
      const leftTime = left.finishedAt ? new Date(left.finishedAt).getTime() : 0;
      const rightTime = right.finishedAt ? new Date(right.finishedAt).getTime() : 0;
      return leftTime - rightTime;
    });

  while (limitRefreshJobs.size > 10 && completedJobs.length > 0) {
    const oldest = completedJobs.shift();
    if (!oldest) break;
    limitRefreshJobs.delete(oldest.jobId);
  }
}

async function ensureOauthCallbackListener() {
  if (oauthCallbackListener) return;
  if (oauthCallbackListenerPromise) return oauthCallbackListenerPromise;

  oauthCallbackListenerPromise = new Promise((resolve, reject) => {
    const listener = app.listen(OPENAI_OAUTH_CALLBACK_PORT, SERVER_HOST);

    listener.once("listening", () => {
      oauthCallbackListener = listener;
      oauthCallbackListenerPromise = null;
      console.log(
        `[codex-auth-switcher] OAuth callback listening on http://localhost:${OPENAI_OAUTH_CALLBACK_PORT}`,
      );
      resolve();
    });

    listener.once("error", (error: NodeJS.ErrnoException) => {
      oauthCallbackListenerPromise = null;
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `OAuth callback port ${OPENAI_OAUTH_CALLBACK_PORT} is already in use. Close other Codex login windows and try again.`,
          ),
        );
        return;
      }

      reject(error);
    });
  });

  return oauthCallbackListenerPromise;
}

async function closeOauthCallbackListenerIfIdle() {
  if (!oauthCallbackListener || hasPendingOauthFlows()) return;

  const listener = oauthCallbackListener;
  oauthCallbackListener = null;

  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  console.log(
    `[codex-auth-switcher] OAuth callback listener stopped on http://localhost:${OPENAI_OAUTH_CALLBACK_PORT}`,
  );
}

function normalizeAlias(input: string | null | undefined) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return normalized.length > 0 ? normalized : null;
}

function getMatchingAccount(
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

function nextAlias(store: StoreFile) {
  let index = 1;
  while (store.accounts.some((account) => account.alias === `acc${index}`)) {
    index += 1;
  }
  return `acc${index}`;
}

function syncStoredAccount(existing: StoredAccount, auth: ExtractedAuth, alias: string) {
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

function resolveAvailableAlias(store: StoreFile, preferredAlias: string, currentAlias?: string | null) {
  if (
    !store.accounts.some(
      (account) => account.alias === preferredAlias && account.alias !== currentAlias,
    )
  ) {
    return preferredAlias;
  }

  return nextAlias(store);
}

function upsertAccount(
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

function sortByRecommendation(accounts: StoredAccount[]) {
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

function sortAccountsForDisplay(accounts: StoredAccount[], currentAlias: string | null) {
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

function recommendedAlias(store: StoreFile) {
  const [first] = sortByRecommendation(
    store.accounts.filter((account) => account.usage != null && account.usage.error == null),
  );
  return first?.alias ?? null;
}

function toDashboardState(store: StoreFile, currentAuth: ExtractedAuth | null) {
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

function renderOauthResultPage({
  title,
  detail,
  error = false,
}: {
  title: string;
  detail: string;
  error?: boolean;
}) {
  const accent = error ? "#dc2626" : "#1d4ed8";
  const background = error ? "#fef2f2" : "#eff6ff";
  const border = error ? "#fecaca" : "#bfdbfe";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;font-family:Inter,system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;padding:24px;">
    <div style="max-width:420px;width:100%;border:1px solid ${border};background:${background};border-radius:24px;padding:28px;">
      <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#64748b;">Codex usage dashboard</div>
      <h1 style="margin:16px 0 10px;font-size:28px;line-height:1.1;color:${accent};">${title}</h1>
      <p style="margin:0;color:#334155;font-size:15px;line-height:1.6;">${detail}</p>
      <p style="margin:18px 0 0;color:#64748b;font-size:13px;">This window can close automatically.</p>
    </div>
    <script>
      setTimeout(() => {
        window.close();
      }, 1200);
    </script>
  </body>
</html>`;
}

async function resolveCurrentAuth() {
  try {
    return await readCurrentAuthFile();
  } catch {
    return null;
  }
}

async function refreshUsageWithAutoTokenRefresh(account: StoredAccount) {
  try {
    const usage = await fetchUsageForAccount(account);
    account.usage = usage;
    account.lastLimitRefreshAt = usage.fetchedAt;
    account.planType = usage.planType ?? account.planType;
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Usage refresh failed";
    const shouldRetry = message.includes("(401)") || message.includes("(403)");

    if (shouldRetry) {
      try {
        await refreshStoredAccount(account);
        const usage = await fetchUsageForAccount(account);
        account.usage = usage;
        account.lastLimitRefreshAt = usage.fetchedAt;
        account.planType = usage.planType ?? account.planType;
        return;
      } catch (retryError) {
        const retryMessage =
          retryError instanceof Error ? retryError.message : "Usage refresh failed after token refresh";
        account.usage = {
          planType: account.planType,
          rateLimit: account.usage?.rateLimit ?? null,
          codeReviewRateLimit: account.usage?.codeReviewRateLimit ?? null,
          credits: account.usage?.credits ?? null,
          fetchedAt: new Date().toISOString(),
          error: retryMessage,
        };
        account.lastLimitRefreshAt = account.usage.fetchedAt;
        return;
      }
    }

    const failedUsage: UsageRecord = {
      planType: account.planType,
      rateLimit: account.usage?.rateLimit ?? null,
      codeReviewRateLimit: account.usage?.codeReviewRateLimit ?? null,
      credits: account.usage?.credits ?? null,
      fetchedAt: new Date().toISOString(),
      error: message,
    };
    account.usage = failedUsage;
    account.lastLimitRefreshAt = failedUsage.fetchedAt;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
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

function getLimitRefreshJob(jobId: string) {
  pruneLimitRefreshJobs();
  const job = limitRefreshJobs.get(jobId);
  return job ? toPublicLimitRefreshJob(job) : null;
}

async function runLimitRefreshJob(job: LimitRefreshJob) {
  const store = await loadStore();
  const targets = [...store.accounts];
  let saveQueue = Promise.resolve();

  const queueSave = () => {
    saveQueue = saveQueue.then(() => saveStore(store));
    return saveQueue;
  };

  await runWithConcurrency(targets, MAX_PARALLEL_ACCOUNT_REFRESH, async (account) => {
    try {
      await refreshUsageWithAutoTokenRefresh(account);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Limit refresh failed";
      job.failed += 1;
      job.errors.push({
        alias: account.alias,
        message,
      });
      account.usage = {
        planType: account.planType,
        rateLimit: account.usage?.rateLimit ?? null,
        codeReviewRateLimit: account.usage?.codeReviewRateLimit ?? null,
        credits: account.usage?.credits ?? null,
        fetchedAt: new Date().toISOString(),
        error: message,
      };
      account.lastLimitRefreshAt = account.usage.fetchedAt;
    } finally {
      job.completed += 1;
      store.lastSyncedAt = new Date().toISOString();
      await queueSave();
    }
  });

  await saveQueue;
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  activeLimitRefreshJobId = null;
  pruneLimitRefreshJobs();
}

async function startLimitRefreshJob() {
  pruneLimitRefreshJobs();

  if (activeLimitRefreshJobId) {
    const activeJob = limitRefreshJobs.get(activeLimitRefreshJobId);
    if (activeJob) {
      return toPublicLimitRefreshJob(activeJob);
    }
  }

  const store = await loadStore();
  if (store.accounts.length === 0) {
    return null;
  }

  const job: LimitRefreshJob = {
    jobId: crypto.randomUUID(),
    status: "running",
    total: store.accounts.length,
    completed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errors: [],
  };

  limitRefreshJobs.set(job.jobId, job);
  activeLimitRefreshJobId = job.jobId;

  void runLimitRefreshJob(job).catch((error) => {
    job.failed = Math.max(job.failed, job.total - job.completed);
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.errors.push({
      alias: "system",
      message: error instanceof Error ? error.message : "Bulk limit refresh crashed",
    });
    activeLimitRefreshJobId = null;
    pruneLimitRefreshJobs();
  });

  return toPublicLimitRefreshJob(job);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/state", async (_req, res) => {
  const store = await loadStore();
  const currentAuth = await resolveCurrentAuth();
  res.json(toDashboardState(store, currentAuth));
});

app.post("/api/sync-current", async (req, res) => {
  const rawAlias = typeof req.body?.alias === "string" ? req.body.alias : "";
  const aliasInput = normalizeAlias(rawAlias);

  if (rawAlias.trim().length > 0 && !aliasInput) {
    res.status(400).json({ error: "Alias is invalid" });
    return;
  }

  const store = await loadStore();
  const current = await readCurrentAuthFile();
  const matched = getMatchingAccount(
    store,
    current.fingerprint,
    current.email,
    current.accountId,
    current.planType,
  );

  if (
    aliasInput &&
    !matched?.account &&
    store.accounts.some((account) => account.alias === aliasInput)
  ) {
    res.status(409).json({ error: `Alias '${aliasInput}' is already in use` });
    return;
  }

  const alias = aliasInput ?? matched?.account.alias ?? nextAlias(store);
  const result = upsertAccount(store, current, alias);
  await refreshUsageWithAutoTokenRefresh(result.account);
  await saveStore(store);

  res.json({
    account: toDashboardState(store, current).accounts.find(
      (item) => item.alias === result.alias,
    ),
    created: result.created,
  });
});

app.post("/api/oauth/start", async (req, res) => {
  const rawAlias = typeof req.body?.alias === "string" ? req.body.alias : "";
  const aliasInput = normalizeAlias(rawAlias);

  if (rawAlias.trim().length > 0 && !aliasInput) {
    res.status(400).json({ error: "Alias is invalid" });
    return;
  }

  const store = await loadStore();
  const alias = aliasInput ?? nextAlias(store);
  if (store.accounts.some((account) => account.alias === alias)) {
    res.status(409).json({ error: `Alias '${alias}' is already in use` });
    return;
  }

  try {
    await ensureOauthCallbackListener();
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "OAuth callback listener could not start",
    });
    return;
  }

  res.json(startOauthFlow(alias));
});

app.get("/api/oauth/status/:flowId", (req, res) => {
  const flow = getOauthFlow(req.params.flowId);
  if (!flow) {
    res.status(404).json({ error: "OAuth flow not found" });
    return;
  }

  res.json(flow);
});

async function handleOauthCallback(
  req: express.Request,
  res: express.Response,
) {
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;

  if (!state || !code) {
    res
      .status(400)
      .type("html")
      .send(
        renderOauthResultPage({
          title: "OAuth callback failed",
          detail: "The login callback was missing its required code or state.",
          error: true,
        }),
      );
    return;
  }

  const flow = findOauthFlowByState(state);
  if (!flow) {
    res
      .status(404)
      .type("html")
      .send(
        renderOauthResultPage({
          title: "OAuth flow expired",
          detail: "The login flow was not found anymore. Start the OAuth add-account flow again.",
          error: true,
        }),
      );
    return;
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
    const store = await loadStore();
    const auth = buildExtractedAuthFromTokens(tokens);
    const result = upsertAccount(store, auth, flow.alias, { preserveExistingAlias: true });
    await refreshUsageWithAutoTokenRefresh(result.account);
    await saveStore(store);
    console.log(
      "[codex-auth-switcher] OAuth callback result",
      JSON.stringify({
        flowId: flow.id,
        requestedAlias: flow.alias,
        storedAlias: result.alias,
        created: result.created,
        matchReason: result.matchReason,
        email: auth.email,
        accountId: auth.accountId,
      }),
    );
    markOauthFlowSuccess(flow.id, {
      accountAlias: result.alias,
      email: auth.email,
      created: result.created,
      matchReason: result.matchReason,
    });
    void closeOauthCallbackListenerIfIdle();

    res
      .type("html")
      .send(
        renderOauthResultPage({
          title: `Account ${result.alias} added`,
          detail: auth.email
            ? `${auth.email} is now stored in the local pool.`
            : "The account is now stored in the local pool.",
        }),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth login failed";
    markOauthFlowError(flow.id, message);
    void closeOauthCallbackListenerIfIdle();
    res
      .status(500)
      .type("html")
      .send(
        renderOauthResultPage({
          title: "OAuth login failed",
          detail: message,
          error: true,
        }),
      );
  }
}

app.get("/api/oauth/callback", handleOauthCallback);
app.get("/auth/callback", handleOauthCallback);

app.post("/api/accounts/activate", async (req, res) => {
  const alias = normalizeAlias(req.body?.alias);
  if (!alias) {
    res.status(400).json({ error: "Alias is required" });
    return;
  }

  const store = await loadStore();
  const account = store.accounts.find((item) => item.alias === alias);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  account.usageCount += 1;
  await writeCurrentAuthFile(account.rawAuth);
  await saveStore(store);

  const currentAuth = await resolveCurrentAuth();
  res.json(toDashboardState(store, currentAuth));
});

app.post("/api/accounts/refresh-tokens", async (req, res) => {
  const alias = normalizeAlias(req.body?.alias);
  const store = await loadStore();
  const targets = alias ? store.accounts.filter((item) => item.alias === alias) : store.accounts;

  if (targets.length === 0) {
    res.status(404).json({ error: "No matching accounts found" });
    return;
  }

  await runWithConcurrency(targets, MAX_PARALLEL_ACCOUNT_REFRESH, async (account) => {
    await refreshStoredAccount(account);
  });

  await saveStore(store);
  const currentAuth = await resolveCurrentAuth();
  res.json(toDashboardState(store, currentAuth));
});

app.post("/api/accounts/refresh-limits", async (req, res) => {
  const alias = normalizeAlias(req.body?.alias);
  if (!alias) {
    const job = await startLimitRefreshJob();
    if (!job) {
      res.status(404).json({ error: "No matching accounts found" });
      return;
    }

    res.status(202).json(job);
    return;
  }

  const store = await loadStore();
  const targets = store.accounts.filter((item) => item.alias === alias);

  if (targets.length === 0) {
    res.status(404).json({ error: "No matching accounts found" });
    return;
  }

  await runWithConcurrency(targets, MAX_PARALLEL_ACCOUNT_REFRESH, async (account) => {
    await refreshUsageWithAutoTokenRefresh(account);
  });

  await saveStore(store);
  const currentAuth = await resolveCurrentAuth();
  res.json(toDashboardState(store, currentAuth));
});

app.get("/api/accounts/refresh-limits/status/:jobId", (req, res) => {
  const job = getLimitRefreshJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Refresh job not found" });
    return;
  }

  res.json(job);
});

app.post("/api/accounts/delete", async (req, res) => {
  const alias = normalizeAlias(req.body?.alias);
  if (!alias) {
    res.status(400).json({ error: "Alias is required" });
    return;
  }

  const store = await loadStore();
  store.accounts = store.accounts.filter((account) => account.alias !== alias);
  await saveStore(store);

  const currentAuth = await resolveCurrentAuth();
  res.json(toDashboardState(store, currentAuth));
});

const isTauriSidecar = process.env.TAURI_SIDECAR === "1";

if (isProduction && !isTauriSidecar) {
  app.use(express.static(distDir));
  app.get(/.*/, async (_req, res) => {
    const indexHtml = await fs.readFile(path.join(distDir, "index.html"), "utf8");
    res.type("html").send(indexHtml);
  });
}

app.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[codex-auth-switcher] API listening on http://${SERVER_HOST}:${SERVER_PORT}`);
  if (isTauriSidecar) {
    console.log("__SIDECAR_READY__");
  }
});
