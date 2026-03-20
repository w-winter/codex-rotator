import type { NextFunction, Request, Response } from "express";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const isTauriSidecar = process.env.TAURI_SIDECAR === "1";

const TAURI_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

function isLoopbackUrl(value: string | null | undefined) {
  if (!value) return true;

  try {
    const url = new URL(value);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isTauriOrigin(value: string | null | undefined) {
  if (!value) return true;
  return TAURI_ORIGINS.has(value) || value.startsWith("tauri://");
}

export function localOnlyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isTauriSidecar) {
    const origin = req.headers.origin ?? "";
    if (origin && (isTauriOrigin(origin) || isLoopbackUrl(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
    return;
  }

  const hostHeader = req.headers.host?.split(":")[0] ?? "";
  if (hostHeader && !LOOPBACK_HOSTS.has(hostHeader)) {
    res.status(403).json({ error: "Only loopback hosts are allowed" });
    return;
  }

  if (!isLoopbackUrl(req.headers.origin) || !isLoopbackUrl(req.headers.referer)) {
    res.status(403).json({ error: "Cross-origin localhost access is blocked" });
    return;
  }

  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}
