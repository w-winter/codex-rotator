import { useEffect } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { AppShell } from "@/components/layout/app-shell";
import { fetchDashboardState } from "@/lib/api";

export function RootRouteComponent() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnboarding = pathname.startsWith("/onboarding");

  const { data } = useQuery({
    queryKey: ["dashboard-state"],
    queryFn: fetchDashboardState,
    enabled: !isOnboarding,
  });

  useEffect(() => {
    if (isOnboarding) return;
    const done = localStorage.getItem("codex-rotator-onboarding-complete");
    if (data && data.accounts.length === 0 && !done) {
      navigate({ to: "/onboarding" });
    }
  }, [data, isOnboarding, navigate]);

  if (isOnboarding) {
    return (
      <>
        <Outlet />
        <Toaster richColors position="top-right" />
      </>
    );
  }

  return (
    <>
      <AppShell>
        <Outlet />
      </AppShell>
      <Toaster richColors position="top-right" />
    </>
  );
}
