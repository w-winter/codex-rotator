import type {
  DashboardState,
  OauthFlowStartResponse,
  OauthFlowStatusResponse,
  SyncCurrentResponse,
} from "@/lib/types";
import { API_BASE } from "@/lib/env";

function stripHtml(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractErrorMessage(response: Response, bodyText: string, payload: Record<string, unknown> | null) {
  const payloadMessage =
    (typeof payload?.error === "string" && payload.error) ||
    (typeof payload?.message === "string" && payload.message) ||
    (typeof payload?.detail === "string" && payload.detail) ||
    null;

  if (payloadMessage) return payloadMessage;

  const htmlHeadline =
    bodyText.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1] ||
    bodyText.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] ||
    bodyText.match(/<pre[^>]*>(.*?)<\/pre>/i)?.[1] ||
    null;

  const plainText = stripHtml(htmlHeadline ?? bodyText);
  if (plainText) return plainText;

  return `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${input}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error("Local API could not be reached. Restart the dashboard and try again.");
  }

  const bodyText = await response.text();
  let payload: Record<string, unknown> | null = null;

  if (bodyText) {
    try {
      payload = (JSON.parse(bodyText) as Record<string, unknown> | null) ?? null;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(response, bodyText, payload));
  }

  return (payload ?? {}) as T;
}

export function fetchDashboardState() {
  return request<DashboardState>("/api/state");
}

export function syncCurrentAccount(alias?: string) {
  return request<SyncCurrentResponse>("/api/sync-current", {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
}

export function activateAccount(alias: string) {
  return request<DashboardState>("/api/accounts/activate", {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
}

export function refreshAccountLimits(alias?: string) {
  return request<DashboardState>("/api/accounts/refresh-limits", {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
}

export function refreshAccountTokens(alias?: string) {
  return request<DashboardState>("/api/accounts/refresh-tokens", {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
}

export function deleteAccount(alias: string) {
  return request<DashboardState>("/api/accounts/delete", {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
}

export function startOauthAccount(alias?: string) {
  return request<OauthFlowStartResponse>("/api/oauth/start", {
    method: "POST",
    body: JSON.stringify({ alias }),
  });
}

export function fetchOauthStatus(flowId: string) {
  return request<OauthFlowStatusResponse>(`/api/oauth/status/${flowId}`);
}
