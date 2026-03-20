import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import {
  syncCurrentAccount,
  startOauthAccount,
  fetchOauthStatus,
  fetchDashboardState,
} from "@/lib/api";
import { IS_TAURI } from "@/lib/env";
import type { OauthFlowStartResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/logo";

type OnboardingStep = "welcome" | "add-account" | "success";

const stepTransition = {
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -16 },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const },
};

/* -------------------------------------------------------------------------- */
/*  Step 1 — Welcome                                                         */
/* -------------------------------------------------------------------------- */

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center gap-10 text-center">
      <div className="flex flex-col items-center gap-5">
        <div className="flex items-center justify-center rounded-2xl border-2 border-dashed border-border/60 bg-muted/40 p-5">
          <Logo iconOnly className="h-12" />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome to Codex Rotator
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            Manage multiple OpenAI Codex accounts and switch between them instantly.
            Never hit a rate limit again.
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <Button size="lg" onClick={onNext} className="min-w-[200px]">
          <Icon icon="fluent:arrow-right-24-regular" className="mr-2" />
          Get started
        </Button>

        <p className="text-xs text-muted-foreground/60">
          {IS_TAURI ? "Desktop edition" : "Localhost only"} · Your data stays on your device
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — Add Account                                                     */
/* -------------------------------------------------------------------------- */

function AddAccountStep({ onSuccess }: { onSuccess: (alias: string) => void }) {
  const [syncAlias, setSyncAlias] = useState("");
  const [oauthAlias, setOauthAlias] = useState("");
  const [oauthFlow, setOauthFlow] = useState<OauthFlowStartResponse | null>(null);
  const queryClient = useQueryClient();

  const syncMutation = useMutation({
    mutationFn: (alias?: string) => syncCurrentAccount(alias),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
      onSuccess(data.account?.alias ?? syncAlias ?? "synced account");
    },
    onError: (error) => toast.error(error.message),
  });

  const oauthMutation = useMutation({
    mutationFn: (alias?: string) => startOauthAccount(alias),
    onSuccess: async (flow) => {
      setOauthFlow(flow);

      if (IS_TAURI) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(flow.authorizationUrl);
        toast.message(
          `Continue the OpenAI login for ${flow.alias} in your browser, then return here.`,
        );
      } else {
        window.open(
          flow.authorizationUrl,
          "_blank",
          "popup=yes,width=540,height=760",
        );
        toast.message(`Continue the OpenAI login for ${flow.alias}.`);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const oauthStatusQuery = useQuery({
    queryKey: ["oauth-status", oauthFlow?.flowId],
    queryFn: () => fetchOauthStatus(oauthFlow!.flowId),
    enabled: !!oauthFlow,
    refetchInterval: 1500,
  });

  // Handle OAuth result
  if (oauthStatusQuery.data?.status === "success") {
    const storedAlias = oauthStatusQuery.data.accountAlias ?? oauthFlow?.alias ?? "new account";
    queryClient.invalidateQueries({ queryKey: ["dashboard-state"] });
    // Defer to avoid state update during render
    setTimeout(() => onSuccess(storedAlias), 0);
  }

  if (oauthStatusQuery.data?.status === "error") {
    toast.error(oauthStatusQuery.data.error || "OAuth flow failed");
    setOauthFlow(null);
  }

  const isOauthPolling = !!oauthFlow && oauthStatusQuery.data?.status === "pending";

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Add your first account
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Import your current device account or sign in with OpenAI to get started.
        </p>
      </div>

      <div className="grid w-full gap-4 sm:grid-cols-2">
        {/* Sync current account */}
        <Card className="flex flex-col">
          <div className="flex flex-1 flex-col gap-4 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                <Icon icon="fluent:arrow-sync-24-regular" className="text-lg text-foreground" />
              </div>
              <div>
                <div className="text-sm font-medium">Sync current account</div>
                <div className="text-xs text-muted-foreground">
                  Import from ~/.codex/auth.json
                </div>
              </div>
            </div>

            <Input
              placeholder="Alias (optional)"
              size="sm"
              value={syncAlias}
              onChange={(e) => setSyncAlias(e.target.value)}
            />

            <Button
              variant="outline"
              size="sm"
              onClick={() => syncMutation.mutate(syncAlias || undefined)}
              disabled={syncMutation.isPending}
              className="mt-auto"
            >
              {syncMutation.isPending ? (
                <>
                  <Icon icon="fluent:spinner-ios-20-regular" className="mr-2 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <Icon icon="fluent:arrow-download-24-regular" className="mr-2" />
                  Sync account
                </>
              )}
            </Button>
          </div>
        </Card>

        {/* OAuth login */}
        <Card className="flex flex-col">
          <div className="flex flex-1 flex-col gap-4 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                <Icon icon="fluent:key-24-regular" className="text-lg text-foreground" />
              </div>
              <div>
                <div className="text-sm font-medium">Login with OpenAI</div>
                <div className="text-xs text-muted-foreground">
                  Sign in via {IS_TAURI ? "browser" : "popup"}
                </div>
              </div>
            </div>

            <Input
              placeholder="Alias (optional)"
              size="sm"
              value={oauthAlias}
              onChange={(e) => setOauthAlias(e.target.value)}
              disabled={isOauthPolling}
            />

            <Button
              size="sm"
              onClick={() => oauthMutation.mutate(oauthAlias || undefined)}
              disabled={oauthMutation.isPending || isOauthPolling}
              className="mt-auto"
            >
              {isOauthPolling ? (
                <>
                  <Icon icon="fluent:spinner-ios-20-regular" className="mr-2 animate-spin" />
                  Waiting for login...
                </>
              ) : oauthMutation.isPending ? (
                <>
                  <Icon icon="fluent:spinner-ios-20-regular" className="mr-2 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Icon icon="fluent:open-24-regular" className="mr-2" />
                  Login with OpenAI
                </>
              )}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step 3 — Success                                                         */
/* -------------------------------------------------------------------------- */

function SuccessStep({
  alias,
  onFinish,
}: {
  alias: string;
  onFinish: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 20 }}
        className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10"
      >
        <Icon icon="fluent:checkmark-24-filled" className="text-3xl text-success" />
      </motion.div>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">You're all set</h1>
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{alias}</span> has been added
          to your account pool. You can add more accounts from the dashboard.
        </p>
      </div>

      <Button size="lg" onClick={onFinish} className="min-w-[200px]">
        <Icon icon="fluent:arrow-right-24-regular" className="mr-2" />
        Go to dashboard
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Onboarding Page                                                          */
/* -------------------------------------------------------------------------- */

export function OnboardingPage() {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [addedAlias, setAddedAlias] = useState("");
  const navigate = useNavigate();

  function handleAccountAdded(alias: string) {
    setAddedAlias(alias);
    setStep("success");
  }

  function handleFinish() {
    localStorage.setItem("codex-rotator-onboarding-complete", "1");
    navigate({ to: "/" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <AnimatePresence mode="wait">
        {step === "welcome" && (
          <motion.div key="welcome" {...stepTransition}>
            <WelcomeStep onNext={() => setStep("add-account")} />
          </motion.div>
        )}
        {step === "add-account" && (
          <motion.div key="add-account" {...stepTransition} className="w-full max-w-2xl">
            <AddAccountStep onSuccess={handleAccountAdded} />
          </motion.div>
        )}
        {step === "success" && (
          <motion.div key="success" {...stepTransition}>
            <SuccessStep alias={addedAlias} onFinish={handleFinish} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
