export const IS_TAURI = Boolean(
  typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
);

// In Tauri dev mode: webview loads from http://localhost:5173, Vite proxy handles /api → relative URLs work
// In Tauri production: webview loads from tauri:// scheme, need absolute URL to reach sidecar
const isTauriProduction =
  IS_TAURI && typeof window !== "undefined" && window.location.protocol === "tauri:";

export const API_BASE = isTauriProduction ? "http://127.0.0.1:3210" : "";
