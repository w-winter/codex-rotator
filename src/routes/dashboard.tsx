import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  activateAccount,
  deleteAccount,
  fetchBulkLimitRefreshStatus,
  fetchDashboardState,
  fetchOauthStatus,
  refreshAccountLimits,
  refreshAccountTokens,
  startBulkLimitRefresh,
  startOauthAccount,
  startOauthReconnect,
  syncCurrentAccount,
} from "@/lib/api";
import { IS_TAURI } from "@/lib/env";
import type {
  AccountSummary,
  DashboardState,
  LimitWindow,
  LimitRefreshJob,
  OauthFlowStartResponse,
} from "@/lib/types";
import { AccordionCard, useAccordionCardState } from "@/components/ui/accordion-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type OauthFlowRequest =
  | { intent: "add"; alias?: string }
  | { intent: "reconnect"; alias: string };

function formatDateTime(value: string | null) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatEpoch(value: number | null) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function formatRemainingWindow(window: LimitWindow | null) {
  if (window?.resetAfterSeconds == null) return "Unknown";

  const totalMinutes = Math.max(0, Math.round(window.resetAfterSeconds / 60));
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (totalHours >= 24) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (totalHours > 0) {
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }

  return `${minutes}m`;
}

function formatWindowDuration(seconds: number | null) {
  if (!seconds) return "Window unavailable";
  const totalHours = Math.round(seconds / 3600);
  if (totalHours >= 24 && totalHours % 24 === 0) {
    return `${totalHours / 24}-day window`;
  }
  return `${totalHours}-hour window`;
}

function formatPlanType(value: string | null) {
  if (!value) return "Unknown plan";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clampPercent(value: number | null) {
  if (value == null) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getUsageColor(value: number | null) {
  if (value == null) return "var(--muted-foreground)";
  if (value >= 90) return "var(--destructive)";
  if (value >= 75) return "var(--warning)";
  if (value >= 45) return "var(--primary)";
  return "var(--success)";
}

function getUsageVariant(
  value: number | null,
): "secondary" | "warning" | "destructive" | "accent" | "success" {
  if (value == null) return "secondary";
  if (value >= 90) return "destructive";
  if (value >= 75) return "warning";
  if (value >= 45) return "accent";
  return "success";
}

function compactCredits(account: AccountSummary) {
  const local = account.usage?.credits?.approxLocalMessages;
  const cloud = account.usage?.credits?.approxCloudMessages;

  return [local != null ? `Local ${local}` : null, cloud != null ? `Cloud ${cloud}` : null]
    .filter(Boolean)
    .join(" · ");
}

function isAccountReady(account: AccountSummary) {
  return account.usage != null && account.usage.error == null;
}

function isWindowExhausted(window: LimitWindow | null): boolean {
  return window?.usedPercent != null && window.usedPercent >= 100;
}

function formatResetTime(window: LimitWindow | null): string | null {
  if (!window?.resetAt) return null;
  return new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(
    new Date(window.resetAt * 1000),
  );
}

function getUsageBreakdown(window: LimitWindow | null) {
  if (window?.usedPercent == null) {
    return {
      available: false,
      used: 0,
      remaining: 100,
    };
  }

  const used = clampPercent(window?.usedPercent ?? null);
  return {
    available: true,
    used,
    remaining: Math.max(0, 100 - used),
  };
}

function maybeNotify(state: DashboardState) {
  const current = state.accounts.find((account) => account.onDevice);
  const percent = current?.usage?.rateLimit?.primaryWindow?.usedPercent ?? 0;

  if (!current || percent < state.thresholds.notifyPercent) return;

  const key = `codex-auth-switcher-notified:${current.alias}:${percent}`;
  if (window.sessionStorage.getItem(key)) return;
  window.sessionStorage.setItem(key, "1");

  toast.warning(`${current.alias} is nearing its primary limit`, {
    description: `${percent}% used. Close and reopen Codex after switching if needed.`,
  });

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Codex account nearing limit", {
      body: `${current.alias} is at ${percent}% primary usage.`,
    });
  }
}

function useDashboardQuery() {
  const stateQuery = useQuery({
    queryKey: ["dashboard-state"],
    queryFn: fetchDashboardState,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!stateQuery.data) return;
    maybeNotify(stateQuery.data);
  }, [stateQuery.data]);

  useEffect(() => {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    Notification.requestPermission().catch(() => undefined);
  }, []);

  return stateQuery;
}

function PageState({ state }: { state: DashboardState | undefined }) {
  const currentAccount = state?.accounts.find((account) => account.onDevice) ?? null;
  const recommendedAccount = state?.accounts.find((account) => account.recommended) ?? null;
  const readyCount = state?.accounts.filter(isAccountReady).length ?? 0;

  return {
    currentAccount,
    recommendedAccount,
    readyCount,
  };
}

function OverviewMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-muted/40 p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-lg font-medium tracking-tight text-foreground">{value}</div>
      <p className="text-sm leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function UsageStrip({
  label,
  window,
}: {
  label: string;
  window: LimitWindow | null;
}) {
  const { available, used, remaining } = getUsageBreakdown(window);

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </div>
        <Badge variant={getUsageVariant(window?.usedPercent ?? null)}>
          {window?.usedPercent == null ? "Unavailable" : `${used}% used`}
        </Badge>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full transition-[width]"
          style={{
            width: `${used}%`,
            backgroundColor: getUsageColor(window?.usedPercent ?? null),
          }}
        />
        <div
          className="h-full bg-border/70"
          style={{
            width: `${remaining}%`,
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{formatRemainingWindow(window)} to reset</span>
        <span className="font-medium text-foreground">
          {available ? `${remaining}% left` : "Unavailable"}
        </span>
      </div>
    </div>
  );
}

function CollapsedMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium leading-relaxed text-foreground">{value}</div>
    </div>
  );
}

function UsageDetailPanel({
  title,
  window,
  note,
}: {
  title: string;
  window: LimitWindow | null;
  note?: string | null;
}) {
  const { available, used, remaining } = getUsageBreakdown(window);

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {title}
          </div>
          <div className="mt-2 text-lg font-medium text-foreground">
            {formatWindowDuration(window?.limitWindowSeconds ?? null)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={getUsageVariant(window?.usedPercent ?? null)}>
            {window?.usedPercent == null ? "Unavailable" : `${used}% used`}
          </Badge>
          <Badge variant="secondary">{remaining}% left</Badge>
        </div>
      </div>

      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full"
          style={{
            width: `${used}%`,
            backgroundColor: getUsageColor(window?.usedPercent ?? null),
          }}
        />
        <div className="h-full bg-border/70" style={{ width: `${remaining}%` }} />
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <span className="font-medium text-foreground">
          {available ? `Used ${used}%` : "Used unavailable"}
        </span>
        <span className="text-muted-foreground">
          {available ? `Remaining ${remaining}%` : "Remaining unavailable"}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <CollapsedMetric label="Resets in" value={formatRemainingWindow(window)} />
        <CollapsedMetric label="Resets at" value={formatEpoch(window?.resetAt ?? null)} />
      </div>

      {note ? <p className="text-sm leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function AccountAccordion({
  account,
  onActivate,
  onReconnect,
  onRefreshTokens,
  onRefreshLimits,
  onDelete,
  oauthBusy,
}: {
  account: AccountSummary;
  onActivate: (alias: string) => void;
  onReconnect: (alias: string) => void;
  onRefreshTokens: (alias: string) => void;
  onRefreshLimits: (alias: string) => void;
  onDelete: (alias: string) => void;
  oauthBusy: boolean;
}) {
  const primaryWindow = account.usage?.rateLimit?.primaryWindow ?? null;
  const weeklyWindow = account.usage?.rateLimit?.secondaryWindow ?? null;
  const creditsSummary = compactCredits(account);
  const weeklyNote = account.usage?.credits?.balance
    ? `Credits balance: ${account.usage.credits.balance}`
    : null;
  const ready = isAccountReady(account);
  const needsRefresh = account.usage?.error != null;
  const reconnectRequired = account.requiresReconnect;
  const weeklyExhausted = isWindowExhausted(weeklyWindow);
  const primaryExhausted = isWindowExhausted(primaryWindow);
  const primaryResetTime = primaryExhausted ? formatResetTime(primaryWindow) : null;

  const cardState = useAccordionCardState({
    defaultOpen: false,
  });

  const cardRef = useRef<HTMLDivElement>(null);

  function handleClose() {
    const el = cardRef.current;
    if (!el) { cardState.closeCard(); return; }
    const topBefore = el.getBoundingClientRect().top;
    cardState.closeCard();
    // Wait for the collapse animation (~250ms) then restore viewport position
    setTimeout(() => {
      const topAfter = el.getBoundingClientRect().top;
      window.scrollBy({ top: topAfter - topBefore, behavior: "instant" });
    }, 270);
  }

  return (
    <div ref={cardRef}>
    <AccordionCard
      state={cardState}
      cardClassName={cn("bg-muted/50", weeklyExhausted && "opacity-60")}
      triggerClassName="px-5 py-5"
      footerClassName="px-0"
      collapsedContainerClassName="px-5"
      expandedContainerClassName="px-5"
      header={
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono text-[11px] tracking-tight">
                {account.alias}
              </Badge>
              <Badge variant="outline">{formatPlanType(account.planType)}</Badge>
              {account.onDevice ? <Badge variant="success">Active in Codex</Badge> : null}
              {account.recommended ? <Badge variant="accent">Recommended</Badge> : null}
              <Badge variant={reconnectRequired || needsRefresh ? "warning" : ready ? "success" : "secondary"}>
                {reconnectRequired ? "Reconnect required" : needsRefresh ? "Needs refresh" : ready ? "Ready" : "Pending limits"}
              </Badge>
              {weeklyExhausted ? (
                <Badge variant="destructive">Weekly exhausted · Unusable</Badge>
              ) : primaryExhausted ? (
                <Badge variant="warning">
                  Primary resets{primaryResetTime ? ` at ${primaryResetTime}` : " soon"}
                </Badge>
              ) : null}
            </div>

            <div className="space-y-1">
              <div className="break-words text-xl font-medium tracking-tight text-foreground">
                {account.email || "No email found"}
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {primaryExhausted
                  ? <>Primary available{primaryResetTime ? <> at <span className="font-medium text-foreground">{primaryResetTime}</span></> : " soon"}.</>
                  : <>Primary resets in {formatRemainingWindow(primaryWindow)}.</>
                }{" "}
                {weeklyExhausted
                  ? <span className="font-medium text-destructive/80">Weekly limit exhausted.</span>
                  : <>Weekly resets in {formatRemainingWindow(weeklyWindow)}.</>
                }
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:min-w-[360px]">
            <UsageStrip label="Primary" window={primaryWindow} />
            <UsageStrip label="Weekly" window={weeklyWindow} />
          </div>
        </div>
      }
      collapsedContent={
        <div className="flex flex-col">
          {account.usage?.error ? (
            <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-3 text-sm leading-relaxed text-warning-foreground">
              <div>{account.usage.error}</div>
              {reconnectRequired ? (
                <div className="mt-2 text-warning-foreground/80">
                  Use Reconnect to refresh the stored login for this alias.
                </div>
              ) : null}
            </div>
          ) : account.usage == null ? (
            <div className="rounded-xl border border-border/50 bg-background px-3 py-3 text-sm leading-relaxed text-muted-foreground">
              Limit windows have not been fetched yet. Use refresh limits if they do not appear automatically.
            </div>
          ) : null}
          <button
            type="button"
            onClick={cardState.openCard}
            className="flex w-full items-center justify-center gap-2 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            View details
            <Icon icon="fluent:chevron-down-20-regular" className="size-4" />
          </button>
        </div>
      }
      expandedContent={
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <CollapsedMetric label="Alias" value={account.alias} />
            <CollapsedMetric label="Last synced" value={formatDateTime(account.lastSyncedAt)} />
            <CollapsedMetric
              label="Token refresh"
              value={formatDateTime(account.lastTokenRefreshAt)}
            />
            <CollapsedMetric label="Usage count" value={String(account.usageCount)} />
          </div>

          <Separator />

          <div className="grid gap-4 lg:grid-cols-2">
            <UsageDetailPanel
              title="Primary limit"
              window={primaryWindow}
              note={creditsSummary || null}
            />
            <UsageDetailPanel title="Weekly limit" window={weeklyWindow} note={weeklyNote} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onActivate(account.alias)}>Use on device</Button>
            {reconnectRequired ? (
              <Button
                variant="mutedBordered"
                onClick={() => onReconnect(account.alias)}
                disabled={oauthBusy}
              >
                Reconnect
              </Button>
            ) : (
              <Button variant="mutedBordered" onClick={() => onRefreshTokens(account.alias)}>
                Refresh token
              </Button>
            )}
            <Button variant="mutedBordered" onClick={() => onRefreshLimits(account.alias)}>
              Refresh limits
            </Button>
            <div className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <Button variant="destructive" onClick={() => onDelete(account.alias)}>
              <Icon icon="fluent:delete-20-regular" data-icon="inline-start" />
              Remove
            </Button>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="flex w-full items-center justify-center gap-2 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Close details
            <Icon icon="fluent:chevron-up-20-regular" className="size-4" />
          </button>
        </div>
      }
    />
    </div>
  );
}

function PoolPressureList({ accounts }: { accounts: AccountSummary[] }) {
  const sorted = [...accounts].sort((a, b) => {
    const aU = a.usage?.rateLimit?.primaryWindow?.usedPercent ?? 0;
    const bU = b.usage?.rateLimit?.primaryWindow?.usedPercent ?? 0;
    return bU - aU;
  });

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl bg-muted/50 px-4 py-10 text-center text-sm text-muted-foreground">
        No accounts yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/40">
      {sorted.map((account) => {
        const primaryWin = account.usage?.rateLimit?.primaryWindow ?? null;
        const weeklyWin = account.usage?.rateLimit?.secondaryWindow ?? null;
        const primary = getUsageBreakdown(primaryWin);
        const weekly = getUsageBreakdown(weeklyWin);
        const weeklyEx = isWindowExhausted(weeklyWin);
        const primaryEx = isWindowExhausted(primaryWin);
        const resetTime = primaryEx ? formatResetTime(primaryWin) : null;
        const label = account.email ?? account.alias;

        return (
          <div
            key={account.alias}
            className={cn(
              "flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0",
              weeklyEx && "opacity-60",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {weeklyEx ? (
                  <Badge variant="destructive" className="text-[10px]">Quota exhausted</Badge>
                ) : primaryEx ? (
                  <Badge variant="warning" className="text-[10px]">
                    Available{resetTime ? ` at ${resetTime}` : " soon"}
                  </Badge>
                ) : (
                  <>
                    {account.onDevice ? <Badge variant="success" className="text-[10px]">Active in Codex</Badge> : null}
                    {account.recommended ? <Badge variant="accent" className="text-[10px]">Recommended</Badge> : null}
                    <Badge variant={getUsageVariant(primaryWin?.usedPercent ?? null)} className="text-[10px]">
                      {primary.used}% used
                    </Badge>
                  </>
                )}
              </div>
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-sm text-muted-foreground">Primary</span>
                <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{
                      width: `${primary.used}%`,
                      backgroundColor: getUsageColor(primaryWin?.usedPercent ?? null),
                    }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-sm text-muted-foreground">
                  {primaryEx && resetTime ? `at ${resetTime}` : `${primary.remaining}% left`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-sm text-muted-foreground">Weekly</span>
                <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{
                      width: `${weekly.used}%`,
                      backgroundColor: weeklyEx
                        ? "var(--muted-foreground)"
                        : getUsageColor(weeklyWin?.usedPercent ?? null),
                    }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-sm text-muted-foreground">
                  {weeklyEx ? "Exhausted" : `${weekly.remaining}% left`}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NextResetsCard({ accounts }: { accounts: AccountSummary[] }) {
  const withResets = accounts
    .filter((a) => a.usage?.rateLimit?.primaryWindow?.resetAfterSeconds != null)
    .sort(
      (a, b) =>
        (a.usage!.rateLimit!.primaryWindow!.resetAfterSeconds ?? Infinity) -
        (b.usage!.rateLimit!.primaryWindow!.resetAfterSeconds ?? Infinity),
    );

  return (
    <Card className="h-full">
      <CardHeader className="p-5 pb-3">
        <CardTitle className="text-lg font-medium tracking-tight">Upcoming resets</CardTitle>
        <CardDescription className="text-sm leading-relaxed">
          Primary and weekly windows, soonest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-5 pt-2">
        {withResets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reset data yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border/40">
            {withResets.map((account) => {
              const pWin = account.usage!.rateLimit!.primaryWindow!;
              const wWin = account.usage?.rateLimit?.secondaryWindow ?? null;
              const pUsed = clampPercent(pWin.usedPercent ?? null);
              const pEx = isWindowExhausted(pWin);
              const wEx = isWindowExhausted(wWin);
              const fmt = (ts: number) =>
                new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(ts * 1000));
              return (
                <div key={account.alias} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <span className="text-sm font-medium text-foreground">
                    {account.email ?? account.alias}
                  </span>
                  {/* Primary row */}
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Primary</span>
                      <span
                        className="text-xs font-medium tabular-nums"
                        style={{ color: getUsageColor(pWin.usedPercent ?? null) }}
                      >
                        {pEx ? (pWin.resetAt ? `resets ${fmt(pWin.resetAt)}` : "exhausted") : formatRemainingWindow(pWin)}
                      </span>
                    </div>
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-[width]"
                        style={{
                          width: `${pUsed}%`,
                          backgroundColor: pEx ? "var(--muted-foreground)" : getUsageColor(pWin.usedPercent ?? null),
                        }}
                      />
                    </div>
                  </div>
                  {/* Weekly row */}
                  {wWin && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">Weekly</span>
                        <span
                          className="text-xs font-medium tabular-nums"
                          style={{ color: wEx ? "var(--muted-foreground)" : getUsageColor(wWin.usedPercent ?? null) }}
                        >
                          {wEx ? (wWin.resetAt ? `resets ${fmt(wWin.resetAt)}` : "exhausted") : formatRemainingWindow(wWin)}
                        </span>
                      </div>
                      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-[width]"
                          style={{
                            width: `${clampPercent(wWin.usedPercent ?? null)}%`,
                            backgroundColor: wEx ? "var(--muted-foreground)" : getUsageColor(wWin.usedPercent ?? null),
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBanner({
  isLoading,
  error,
  loadingLabel,
}: {
  isLoading: boolean;
  error: Error | null;
  loadingLabel: string;
}) {
  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive">
        {error.message}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl bg-muted/50 px-5 py-6 text-sm text-muted-foreground">
        {loadingLabel}
      </div>
    );
  }

  return null;
}

export function OverviewPage() {
  const stateQuery = useDashboardQuery();
  const { currentAccount, recommendedAccount, readyCount } = PageState({
    state: stateQuery.data,
  });

  const accounts = stateQuery.data?.accounts ?? [];

  // Calmest account = one with lowest primary used%
  const calmest = accounts.length > 0
    ? [...accounts].sort((a, b) => {
        const aU = a.usage?.rateLimit?.primaryWindow?.usedPercent ?? Infinity;
        const bU = b.usage?.rateLimit?.primaryWindow?.usedPercent ?? Infinity;
        return aU - bU;
      })[0]
    : null;

  const calmestHours = calmest?.usage?.rateLimit?.primaryWindow?.resetAfterSeconds != null
    ? Math.round(calmest.usage.rateLimit.primaryWindow.resetAfterSeconds / 3600)
    : null;

  const poolCalmLabel = calmest
    ? `${calmest.email ?? calmest.alias} · ${clampPercent(calmest.usage?.rateLimit?.primaryWindow?.usedPercent ?? null)}% primary used`
    : "No data";

  return (
    <div className="flex flex-col gap-6">
      <StatusBanner
        isLoading={stateQuery.isLoading}
        error={stateQuery.isError ? stateQuery.error : null}
        loadingLabel="Loading usage overview..."
      />

      {/* Top row — 3 metrics + badges, no height-matched pair */}
      <section>
        <Card>
          <CardHeader className="p-5 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-lg font-medium tracking-tight">
                  Switching picture
                </CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">Localhost only</Badge>
                <Badge variant="secondary">
                  Notify at {stateQuery.data?.thresholds.notifyPercent ?? 0}%
                </Badge>
              </div>
            </div>
            <CardDescription className="text-sm leading-relaxed">
              See the current device auth, the best next switch, and how much of the pool is still
              calm before you touch anything.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 pt-0 sm:grid-cols-2 lg:grid-cols-4">
            <OverviewMetric
              label="Current on device"
              value={currentAccount?.email ?? currentAccount?.alias ?? "None"}
              detail={
                currentAccount
                  ? `Alias: ${currentAccount.alias}`
                  : "No account is currently written to ~/.codex/auth.json."
              }
            />
            <OverviewMetric
              label="Best next switch"
              value={recommendedAccount?.email ?? recommendedAccount?.alias ?? "None"}
              detail={
                recommendedAccount
                  ? `Alias: ${recommendedAccount.alias}`
                  : "Refresh limits to calculate the lowest-pressure next account."
              }
            />
            <OverviewMetric
              label="Pool readiness"
              value={`${readyCount}/${accounts.length}`}
              detail="Healthy accounts stored, refreshed, and ready to use on device."
            />
            <OverviewMetric
              label="Calmest account"
              value={calmest?.email ?? calmest?.alias ?? "None"}
              detail={
                calmestHours != null
                  ? `Primary resets in ${calmestHours}h · ${clampPercent(calmest?.usage?.rateLimit?.primaryWindow?.usedPercent ?? null)}% used`
                  : "No limit data yet."
              }
            />
          </CardContent>
        </Card>
      </section>

      {/* Account pressure list + pool health */}
      <section>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="p-5 pb-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg font-medium tracking-tight">
                      Pool usage snapshot
                    </CardTitle>
                  </div>
                  <Badge variant="secondary">{accounts.length} accounts</Badge>
                </div>
                <CardDescription className="text-sm leading-relaxed">
                  Accounts sorted by primary usage — most loaded first. Shorter bars are calmer
                  switch targets.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-5 pt-2">
                <PoolPressureList accounts={accounts} />
              </CardContent>
            </Card>
          </div>
          <div>
            <NextResetsCard accounts={accounts} />
          </div>
        </div>
      </section>
    </div>
  );
}

export function AccountsPage() {
  const queryClient = useQueryClient();
  const stateQuery = useDashboardQuery();
  const [pendingAlias, setPendingAlias] = useState("");
  const [search, setSearch] = useState("");
  const [oauthFlow, setOauthFlow] = useState<OauthFlowStartResponse | null>(null);
  const [limitRefreshJob, setLimitRefreshJob] = useState<LimitRefreshJob | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);

  const { currentAccount, recommendedAccount } = PageState({
    state: stateQuery.data,
  });

  const oauthStatusQuery = useQuery({
    queryKey: ["oauth-status", oauthFlow?.flowId],
    queryFn: () => fetchOauthStatus(oauthFlow!.flowId),
    enabled: Boolean(oauthFlow?.flowId),
    refetchInterval: (query) => {
      if (!oauthFlow) return false;
      return query.state.data?.status === "pending" || query.state.data == null ? 1_000 : false;
    },
  });

  const limitRefreshStatusQuery = useQuery({
    queryKey: ["limit-refresh-job", limitRefreshJob?.jobId],
    queryFn: () => fetchBulkLimitRefreshStatus(limitRefreshJob!.jobId),
    enabled: Boolean(limitRefreshJob?.jobId),
    refetchInterval: (query) => {
      if (!limitRefreshJob) return false;
      return query.state.data?.status === "running" || query.state.data == null ? 1_000 : false;
    },
  });

  const syncMutation = useMutation({
    mutationFn: (alias?: string) => syncCurrentAccount(alias),
    onSuccess: () => {
      toast.success("Current auth.json synced");
      setPendingAlias("");
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const oauthMutation = useMutation({
    mutationFn: (request: OauthFlowRequest) => {
      return request.intent === "reconnect"
        ? startOauthReconnect(request.alias)
        : startOauthAccount(request.alias);
    },
    onSuccess: async (flow) => {
      setOauthFlow(flow);
      const popup = oauthPopupRef.current;
      const actionLabel = flow.intent === "reconnect" ? "reconnect" : "login";

      if (IS_TAURI) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(flow.authorizationUrl);
        toast.message(`Continue the OpenAI ${actionLabel} for ${flow.alias} in your browser, then return here.`);
        return;
      }

      if (!popup || popup.closed) {
        window.open(flow.authorizationUrl, "_blank", "popup=yes,width=540,height=760");
        toast.message(`Continue the OpenAI ${actionLabel} for ${flow.alias}.`);
        return;
      }

      popup.location.replace(flow.authorizationUrl);
      popup.focus();
      toast.message(`Continue the OpenAI ${actionLabel} for ${flow.alias}.`);
    },
    onError: (error) => {
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      toast.error(error.message);
    },
  });

  const activateMutation = useMutation({
    mutationFn: (alias: string) => activateAccount(alias),
    onSuccess: () => {
      toast.success("auth.json switched on device");
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const refreshTokensMutation = useMutation({
    mutationFn: (alias?: string) => refreshAccountTokens(alias),
    onSuccess: () => {
      toast.success("Token refresh completed");
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const refreshLimitsMutation = useMutation({
    mutationFn: (alias: string) => refreshAccountLimits(alias),
    onSuccess: () => {
      toast.success("Limit refresh completed");
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const bulkRefreshLimitsMutation = useMutation({
    mutationFn: () => startBulkLimitRefresh(),
    onSuccess: (job) => {
      setLimitRefreshJob(job);
      toast.message(`Refreshing ${job.total} accounts in the background.`);
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (alias: string) => deleteAccount(alias),
    onSuccess: () => {
      toast.success("Account removed");
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!oauthFlow || !oauthStatusQuery.data) return;

    if (oauthStatusQuery.data.status === "success") {
      const storedAlias = oauthStatusQuery.data.accountAlias ?? oauthFlow.alias;
      if (oauthFlow.intent === "reconnect") {
        toast.success(`Reconnected ${storedAlias}`);
      } else if (oauthStatusQuery.data.created === false) {
        toast.message("No new account was added", {
          description:
            oauthStatusQuery.data.email != null
              ? `${oauthStatusQuery.data.email} was already the account returned by the login popup and it refreshed ${storedAlias} instead. If you meant a different account, finish the popup with another OpenAI login.`
              : `The login popup returned an account that was already stored as ${storedAlias}. If you meant a different account, finish the popup with another OpenAI login.`,
        });
      } else {
        toast.success(`OAuth account ${storedAlias} added`);
      }
      setPendingAlias("");
      setOauthFlow(null);
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
      return;
    }

    if (oauthStatusQuery.data.status === "error") {
      toast.error(oauthStatusQuery.data.error || "OAuth flow failed");
      setOauthFlow(null);
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
    }
  }, [oauthFlow, oauthStatusQuery.data, queryClient]);

  useEffect(() => {
    const job = limitRefreshStatusQuery.data;
    if (!job) return;

    setLimitRefreshJob(job);
    queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });

    if (job.status === "completed") {
      toast.success(
        job.failed > 0
          ? `Limit refresh finished with ${job.failed} issue${job.failed === 1 ? "" : "s"}`
          : "Limit refresh completed",
      );
    }
  }, [limitRefreshStatusQuery.data, queryClient]);

  useEffect(() => {
    return () => {
      oauthPopupRef.current = null;
    };
  }, []);

  const filteredAccounts = useMemo(() => {
    const state = stateQuery.data;
    if (!state) return [];
    const term = search.trim().toLowerCase();
    if (!term) return state.accounts;

    return state.accounts.filter((account) => {
      return (
        account.alias.toLowerCase().includes(term) ||
        (account.email ?? "").toLowerCase().includes(term) ||
        (account.planType ?? "").toLowerCase().includes(term)
      );
    });
  }, [search, stateQuery.data]);

  function beginOauthFlow(request: OauthFlowRequest) {
    if (IS_TAURI) {
      oauthMutation.mutate(request);
      return;
    }

    const popupName = `codex-oauth-${window.crypto?.randomUUID?.() ?? Date.now()}`;
    const popup = window.open("", popupName, "popup=yes,width=540,height=760");

    if (!popup) {
      toast.error("Allow pop-ups and try the OAuth flow again.");
      return;
    }

    try {
      popup.document.title = "OpenAI login";
      popup.document.body.innerHTML = `
        <div style="min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font-family:Inter,system-ui,sans-serif;padding:24px;">
          <div style="max-width:360px;width:100%;border:1px solid #e2e8f0;border-radius:24px;background:#ffffff;padding:28px;">
            <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#64748b;">Codex usage dashboard</div>
            <h1 style="margin:16px 0 10px;font-size:28px;line-height:1.1;">Preparing login</h1>
            <p style="margin:0;color:#475569;font-size:15px;line-height:1.6;">Your OpenAI account window is being opened.</p>
          </div>
        </div>
      `;
    } catch {
      // Ignore cross-origin popup cases; we only need a live window handle.
    }

    oauthPopupRef.current = popup;
    oauthMutation.mutate(request);
  }

  function handleStartOauth() {
    beginOauthFlow({ intent: "add", alias: pendingAlias || undefined });
  }

  function handleReconnect(alias: string) {
    beginOauthFlow({ intent: "reconnect", alias });
  }

  return (
    <div className="flex flex-col gap-6">
      <StatusBanner
        isLoading={stateQuery.isLoading}
        error={stateQuery.isError ? stateQuery.error : null}
        loadingLabel="Loading stored accounts..."
      />

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="text-xl font-medium tracking-tight text-foreground">
              Stored accounts
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Keep the list calm. Scan the current pressure, open a card only when you need detail,
              then switch and reopen Codex.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {currentAccount ? <Badge variant="success">Current {currentAccount.alias}</Badge> : null}
            {recommendedAccount ? (
              <Badge variant="accent">Recommended {recommendedAccount.alias}</Badge>
            ) : null}
            <Badge variant="secondary">{filteredAccounts.length} visible</Badge>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Input
            placeholder="Search alias / email / plan"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => syncMutation.mutate(undefined)}
                disabled={syncMutation.isPending}
              >
                Sync device auth
              </Button>
              <div className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
              <Button
                variant="mutedBordered"
                onClick={() => refreshTokensMutation.mutate(undefined)}
                disabled={refreshTokensMutation.isPending}
              >
                Refresh tokens (all)
              </Button>
              <Button
                variant="mutedBordered"
                onClick={() => bulkRefreshLimitsMutation.mutate()}
                disabled={bulkRefreshLimitsMutation.isPending || limitRefreshJob?.status === "running"}
              >
                Refresh limits (all)
              </Button>
              <div className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
              <Button variant="ghost" onClick={() => stateQuery.refetch()}>
                Refresh UI
              </Button>
            </div>

            {limitRefreshJob?.status === "running" ? (
              <div className="text-xs text-muted-foreground">
                Refreshing {limitRefreshJob.completed}/{limitRefreshJob.total} accounts...
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Input
                placeholder="Alias (optional)"
                value={pendingAlias}
                onChange={(event) => setPendingAlias(event.target.value)}
                className="w-40"
              />
              <Button
                onClick={handleStartOauth}
                disabled={oauthMutation.isPending || Boolean(oauthFlow)}
              >
                <Icon icon="fluent:person-add-20-regular" data-icon="inline-start" />
                Add account
              </Button>
              {oauthFlow ? <Badge variant="accent">OAuth pending</Badge> : null}
            </div>
          </div>
        </div>

        {oauthFlow ? (
          <div className="rounded-xl bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            {oauthFlow.intent === "reconnect" ? (
              <>
                Reconnect in progress for <span className="font-medium text-foreground">{oauthFlow.alias}</span>.
                Finish the browser login to refresh that stored account.
              </>
            ) : (
              <>
                OAuth login in progress for <span className="font-medium text-foreground">{oauthFlow.alias}</span>.
                Finish the browser login, then this page will pick the account up automatically.
              </>
            )}
          </div>
        ) : null}

        {filteredAccounts.length === 0 && !stateQuery.isLoading ? (
          <div className="rounded-xl bg-muted/50 px-5 py-10 text-center text-sm text-muted-foreground">
            No accounts matched the current filter.
          </div>
        ) : null}

        <div className="grid gap-4">
          {filteredAccounts.map((account) => (
            <AccountAccordion
              key={account.alias}
              account={account}
              onActivate={(alias) => activateMutation.mutate(alias)}
              onReconnect={handleReconnect}
              onRefreshTokens={(alias) => refreshTokensMutation.mutate(alias)}
              onRefreshLimits={(alias) => refreshLimitsMutation.mutate(alias)}
              onDelete={(alias) => deleteMutation.mutate(alias)}
              oauthBusy={oauthMutation.isPending || Boolean(oauthFlow)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function DeviceInfoRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="break-all rounded-lg bg-muted/50 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground">
        {value}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

export function DeviceStatusPage() {
  const queryClient = useQueryClient();
  const stateQuery = useDashboardQuery();
  const { currentAccount } = PageState({ state: stateQuery.data });
  const [aliasDraft, setAliasDraft] = useState("");

  const syncMutation = useMutation({
    mutationFn: (alias?: string) => syncCurrentAccount(alias),
    onSuccess: () => {
      toast.success("Current auth.json synced");
      setAliasDraft("");
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="flex flex-col gap-6">
      <StatusBanner
        isLoading={stateQuery.isLoading}
        error={stateQuery.isError ? stateQuery.error : null}
        loadingLabel="Loading device status..."
      />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="h-full">
          <CardHeader className="p-5 pb-4">
            <CardTitle className="text-lg font-medium tracking-tight">
              Live auth and local vault
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              This is the page for paths, vault state, and session hygiene after switching. Keep it
              separate from the pool so the main views stay focused.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 p-5 pt-0">
            <DeviceInfoRow
              label="Live auth path"
              value={stateQuery.data?.authPath ?? "Loading"}
              detail={
                currentAccount
                  ? `${currentAccount.alias} is currently written to the live Codex auth file.`
                  : "No tracked account is currently mapped to the live Codex auth file."
              }
            />
            <DeviceInfoRow
              label="Vault path"
              value={stateQuery.data?.storePath ?? "Loading"}
              detail={
                stateQuery.data?.storeEncrypted
                  ? "Encrypted local vault storage is enabled."
                  : "Vault encryption is currently disabled."
              }
            />
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader className="p-5 pb-4">
            <CardTitle className="text-lg font-medium tracking-tight">
              Keep switches predictable
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-5 pt-0">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Close and reopen Codex after switching if you want the next session to pick up the new
              auth cleanly.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Browser notifications will warn when the active account reaches{" "}
              {stateQuery.data?.thresholds.notifyPercent ?? 0}% primary usage.
            </p>
            <Input
              placeholder="Optional alias when syncing current device auth"
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => syncMutation.mutate(aliasDraft || undefined)}
                disabled={syncMutation.isPending}
              >
                Sync device auth
              </Button>
              <Button variant="ghost" onClick={() => stateQuery.refetch()}>
                Refresh UI
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
