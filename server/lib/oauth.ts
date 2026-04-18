import crypto from "node:crypto";

import {
  OPENAI_AUTH_BASE_URL,
  OPENAI_OAUTH_CALLBACK_PORT,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ORIGINATOR,
  OPENAI_OAUTH_SCOPE,
} from "./config.js";

type OauthFlowStatus = "pending" | "success" | "error";

type OauthFlowRecord = {
  id: string;
  alias: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authorizationUrl: string;
  status: OauthFlowStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  accountAlias: string | null;
  email: string | null;
  created: boolean | null;
  matchReason: "fingerprint" | "accountId" | null;
};

const FLOW_TTL_MS = 15 * 60 * 1000;
const flowIdsByState = new Map<string, string>();
const flowsById = new Map<string, OauthFlowRecord>();

function toBase64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const verifier = toBase64Url(crypto.randomBytes(32));
  const challenge = toBase64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function pruneExpiredFlows() {
  const now = Date.now();
  for (const [flowId, flow] of flowsById.entries()) {
    const completedAt = flow.completedAt ? new Date(flow.completedAt).getTime() : new Date(flow.startedAt).getTime();
    if (now - completedAt > FLOW_TTL_MS) {
      flowsById.delete(flowId);
      flowIdsByState.delete(flow.state);
    }
  }
}

function toPublicFlow(flow: OauthFlowRecord) {
  return {
    flowId: flow.id,
    alias: flow.alias,
    authorizationUrl: flow.authorizationUrl,
    status: flow.status,
    startedAt: flow.startedAt,
    completedAt: flow.completedAt,
    error: flow.error,
    accountAlias: flow.accountAlias,
    email: flow.email,
    created: flow.created,
    matchReason: flow.matchReason,
  };
}

export function startOauthFlow(alias: string) {
  pruneExpiredFlows();

  const flowId = crypto.randomUUID();
  const state = toBase64Url(crypto.randomBytes(32));
  const { verifier, challenge } = createPkcePair();
  const redirectUri = `http://localhost:${OPENAI_OAUTH_CALLBACK_PORT}/auth/callback`;

  const authorizationUrl = new URL(`${OPENAI_AUTH_BASE_URL}/oauth/authorize`);
  authorizationUrl.searchParams.set("client_id", OPENAI_OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", OPENAI_OAUTH_SCOPE);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("id_token_add_organizations", "true");
  authorizationUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authorizationUrl.searchParams.set("originator", OPENAI_OAUTH_ORIGINATOR);
  authorizationUrl.searchParams.set("prompt", "login");
  authorizationUrl.searchParams.set("max_age", "0");

  const flow: OauthFlowRecord = {
    id: flowId,
    alias,
    state,
    codeVerifier: verifier,
    redirectUri,
    authorizationUrl: authorizationUrl.toString(),
    status: "pending",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    accountAlias: null,
    email: null,
    created: null,
    matchReason: null,
  };

  flowsById.set(flowId, flow);
  flowIdsByState.set(state, flowId);

  return toPublicFlow(flow);
}

export function hasPendingOauthFlows() {
  pruneExpiredFlows();
  for (const flow of flowsById.values()) {
    if (flow.status === "pending") return true;
  }
  return false;
}

export function findOauthFlowByState(state: string) {
  pruneExpiredFlows();
  const flowId = flowIdsByState.get(state);
  return flowId ? flowsById.get(flowId) ?? null : null;
}

export function getOauthFlow(flowId: string) {
  pruneExpiredFlows();
  const flow = flowsById.get(flowId);
  return flow ? toPublicFlow(flow) : null;
}

export function markOauthFlowSuccess(
  flowId: string,
  result: {
    accountAlias: string;
    email: string | null;
    created: boolean;
    matchReason: "fingerprint" | "accountId" | null;
  },
) {
  const flow = flowsById.get(flowId);
  if (!flow) return null;

  flow.status = "success";
  flow.completedAt = new Date().toISOString();
  flow.accountAlias = result.accountAlias;
  flow.email = result.email;
  flow.created = result.created;
  flow.matchReason = result.matchReason;
  flow.error = null;
  return toPublicFlow(flow);
}

export function markOauthFlowError(flowId: string, error: string) {
  const flow = flowsById.get(flowId);
  if (!flow) return null;

  flow.status = "error";
  flow.completedAt = new Date().toISOString();
  flow.error = error;
  flow.created = null;
  flow.matchReason = null;
  return toPublicFlow(flow);
}
