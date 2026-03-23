import os from "node:os";
import path from "node:path";

export const SERVER_HOST = process.env.CODEX_SWITCHER_HOST || "127.0.0.1";
export const SERVER_PORT = Number(process.env.CODEX_SWITCHER_PORT || 3210);
export const OPENAI_OAUTH_CALLBACK_PORT = Number(
  process.env.CODEX_SWITCHER_OAUTH_CALLBACK_PORT || 1455,
);

export const APP_HOME = process.env.CODEX_SWITCHER_HOME || path.join(os.homedir(), ".codex-auth-switcher");
export const STORE_PATH = path.join(APP_HOME, "store.enc.json");
export const KEY_PATH = path.join(APP_HOME, "store.key");
export const CODEX_AUTH_PATH =
  process.env.CODEX_SWITCHER_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");

export const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const OPENAI_OAUTH_ORIGINATOR =
  process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "codex_cli_rs";

export const DEFAULT_NOTIFY_PERCENT = 80;
export const MAX_PARALLEL_ACCOUNT_REFRESH = Number(
  process.env.CODEX_SWITCHER_REFRESH_CONCURRENCY || 12,
);
export const OPENAI_REQUEST_TIMEOUT_MS = Number(
  process.env.CODEX_SWITCHER_REQUEST_TIMEOUT_MS || 10_000,
);
