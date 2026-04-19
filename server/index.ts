import express from "express";
import type { Request, Response } from "express";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { buildExtractedAuthFromTokens } from "./lib/auth-file.js";
import { nextAlias, normalizeAlias } from "./lib/accounts.js";
import {
  AccountServiceError,
  activateAccountOnDevice,
  deleteStoredAccount,
  reconnectStoredAccount,
  refreshAccountLimits,
  refreshAccountTokens,
  resolveCurrentAuth,
  storeExtractedAccount,
  syncCurrentDeviceAuth,
} from "./lib/account-service.js";
import {
  OPENAI_OAUTH_CALLBACK_PORT,
  SERVER_HOST,
  SERVER_PORT,
} from "./lib/config.js";
import { toDashboardState } from "./lib/dashboard-state.js";
import {
  findOauthFlowByState,
  getOauthFlow,
  hasPendingOauthFlows,
  markOauthFlowError,
  markOauthFlowSuccess,
  startOauthFlow,
} from "./lib/oauth.js";
import { exchangeAuthorizationCode } from "./lib/openai.js";
import { localOnlyMiddleware } from "./lib/security.js";
import { loadStore } from "./lib/store.js";

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

function sendJsonError(res: Response, error: unknown) {
  if (error instanceof AccountServiceError) {
    if (error.code === "INVALID_ALIAS") {
      res.status(400).json({ error: error.message });
      return;
    }

    if (
      error.code === "ALIAS_CONFLICT"
      || error.code === "OPERATION_IN_PROGRESS"
      || error.code === "REAUTH_ACCOUNT_MISMATCH"
    ) {
      res.status(409).json({ error: error.message });
      return;
    }

    if (error.code === "ACCOUNT_NOT_FOUND" || error.code === "NO_MATCHING_ACCOUNTS") {
      res.status(404).json({ error: error.message });
      return;
    }
  }

  res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
}

function jsonHandler(handler: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response) => {
    void Promise.resolve(handler(req, res)).catch((error) => sendJsonError(res, error));
  };
}

function getRawAlias(value: unknown) {
  return typeof value === "string" ? value : null;
}

function getLimitRefreshJob(jobId: string) {
  pruneLimitRefreshJobs();
  const job = limitRefreshJobs.get(jobId);
  return job ? toPublicLimitRefreshJob(job) : null;
}

async function runLimitRefreshJob(job: LimitRefreshJob) {
  try {
    const result = await refreshAccountLimits({
      onProgress: async (event) => {
        job.total = event.total;
        job.completed = event.completed;

        if (!event.ok) {
          job.failed += 1;
          job.errors.push({
            alias: event.alias,
            message: event.message ?? "Limit refresh failed",
          });
        }
      },
    });

    job.total = result.total;
    job.completed = result.completed;
    job.failed = result.failed;
    job.errors = result.errors;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
  } finally {
    activeLimitRefreshJobId = null;
    pruneLimitRefreshJobs();
  }
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

app.get(
  "/api/state",
  jsonHandler(async (_req, res) => {
    const store = await loadStore();
    const currentAuth = await resolveCurrentAuth();
    res.json(toDashboardState(store, currentAuth));
  }),
);

app.post(
  "/api/sync-current",
  jsonHandler(async (req, res) => {
    const result = await syncCurrentDeviceAuth({ preferredAlias: getRawAlias(req.body?.alias) });
    const state = toDashboardState(result.store, result.currentAuth);
    const account = state.accounts.find((item) => item.alias === result.alias);

    if (!account) {
      throw new Error(`Stored account '${result.alias}' could not be resolved after sync`);
    }

    res.json({
      account,
      created: result.created,
    });
  }),
);

app.post("/api/oauth/start", async (req, res) => {
  const rawAlias = getRawAlias(req.body?.alias) ?? "";
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

  res.json(startOauthFlow({ alias, intent: "add" }));
});

app.post("/api/oauth/reconnect", async (req, res) => {
  const rawAlias = getRawAlias(req.body?.alias) ?? "";
  const alias = normalizeAlias(rawAlias);

  if (!alias) {
    res.status(400).json({ error: "Alias is invalid" });
    return;
  }

  const store = await loadStore();
  if (!store.accounts.some((account) => account.alias === alias)) {
    res.status(404).json({ error: `Stored account '${alias}' was not found` });
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

  res.json(startOauthFlow({ alias, intent: "reconnect" }));
});

app.get("/api/oauth/status/:flowId", (req, res) => {
  const flow = getOauthFlow(req.params.flowId);
  if (!flow) {
    res.status(404).json({ error: "OAuth flow not found" });
    return;
  }

  res.json(flow);
});

async function handleOauthCallback(req: Request, res: Response) {
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
          detail: "The login flow was not found anymore. Start the OAuth flow again from the dashboard.",
          error: true,
        }),
      );
    return;
  }

  if (flow.status !== "pending") {
    res
      .status(409)
      .type("html")
      .send(
        renderOauthResultPage({
          title: "OAuth flow already completed",
          detail: "This login callback was already used. Start a fresh OAuth flow from the dashboard if you need to try again.",
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
    const auth = buildExtractedAuthFromTokens(tokens);
    const result = flow.intent === "reconnect"
      ? await reconnectStoredAccount({ alias: flow.alias, auth })
      : await storeExtractedAccount({
          auth,
          preferredAlias: flow.alias,
          preserveExistingAlias: true,
        });

    console.log(
      "[codex-auth-switcher] OAuth callback result",
      JSON.stringify({
        flowId: flow.id,
        intent: flow.intent,
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

    const actionLabel = flow.intent === "reconnect" ? "reconnected" : "added";
    const actionDetail = flow.intent === "reconnect"
      ? (auth.email
          ? `${auth.email} is now refreshed for stored account ${result.alias}.`
          : `Stored account ${result.alias} is now refreshed.`)
      : (auth.email
          ? `${auth.email} is now stored in the local pool.`
          : "The account is now stored in the local pool.");

    res
      .type("html")
      .send(
        renderOauthResultPage({
          title: `Account ${result.alias} ${actionLabel}`,
          detail: actionDetail,
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

app.post(
  "/api/accounts/activate",
  jsonHandler(async (req, res) => {
    const result = await activateAccountOnDevice(getRawAlias(req.body?.alias) ?? "");
    const currentAuth = await resolveCurrentAuth();
    res.json(toDashboardState(result.store, currentAuth));
  }),
);

app.post(
  "/api/accounts/refresh-tokens",
  jsonHandler(async (req, res) => {
    const result = await refreshAccountTokens({ alias: getRawAlias(req.body?.alias) });
    const currentAuth = await resolveCurrentAuth();
    res.json(toDashboardState(result.store, currentAuth));
  }),
);

app.post("/api/accounts/refresh-limits", async (req, res) => {
  const rawAlias = getRawAlias(req.body?.alias);
  if (!rawAlias || rawAlias.trim().length === 0) {
    try {
      const job = await startLimitRefreshJob();
      if (!job) {
        res.status(404).json({ error: "No matching accounts found" });
        return;
      }

      res.status(202).json(job);
    } catch (error) {
      sendJsonError(res, error);
    }
    return;
  }

  await jsonHandler(async (_req, innerRes) => {
    const result = await refreshAccountLimits({ alias: rawAlias });
    const currentAuth = await resolveCurrentAuth();
    innerRes.json(toDashboardState(result.store, currentAuth));
  })(req, res);
});

app.get("/api/accounts/refresh-limits/status/:jobId", (req, res) => {
  const job = getLimitRefreshJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Refresh job not found" });
    return;
  }

  res.json(job);
});

app.post(
  "/api/accounts/delete",
  jsonHandler(async (req, res) => {
    const result = await deleteStoredAccount(getRawAlias(req.body?.alias) ?? "");
    const currentAuth = await resolveCurrentAuth();
    res.json(toDashboardState(result.store, currentAuth));
  }),
);

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
