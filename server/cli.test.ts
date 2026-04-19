import assert from "node:assert/strict";
import test from "node:test";

import { HELP_TEXT, parseCliArgs, runCli } from "./cli.js";
import { CODEX_AUTH_PATH } from "./lib/config.js";

const defaultPolicy = {
  preferredAliases: [],
  reserveAliases: [],
  heavyRun: {
    maxPrimaryUsedPercent: 60,
    maxWeeklyUsedPercent: 80,
  },
};

const emptyState = {
  authPath: CODEX_AUTH_PATH,
  storePath: "~/.codex-auth-switcher/store.enc.json",
  storeEncrypted: true,
  currentAlias: null,
  recommendedAlias: null,
  currentAuthKnown: false,
  lastSyncedAt: null,
  thresholds: { notifyPercent: 80 },
  accounts: [],
};

function createIo() {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function createDeps(overrides?: Partial<Parameters<typeof runCli>[2]>) {
  return {
    syncCurrentDeviceAuth: async () => {
      throw new Error("should not run");
    },
    activateAccountOnDevice: async () => {
      throw new Error("should not run");
    },
    refreshAccountTokens: async () => {
      throw new Error("should not run");
    },
    refreshAccountLimits: async () => {
      throw new Error("should not run");
    },
    rotateAccountOnDevice: async () => {
      throw new Error("should not run");
    },
    readRotationPolicy: async () => ({
      policy: defaultPolicy,
      accounts: [],
    }),
    updateRotationPolicy: async () => {
      throw new Error("should not run");
    },
    clearRotationPolicy: async () => {
      throw new Error("should not run");
    },
    readDashboardState: async () => emptyState,
    ...overrides,
  };
}

test("parseCliArgs accepts canonical CLI commands", () => {
  assert.deepEqual(parseCliArgs(["list"]), { kind: "list", json: false });
  assert.deepEqual(parseCliArgs(["rotate"]), { kind: "rotate", json: false });
  assert.deepEqual(parseCliArgs(["policy", "show"]), { kind: "policy-show", json: false });
  assert.deepEqual(parseCliArgs(["policy", "clear"]), { kind: "policy-clear", json: false });
  assert.deepEqual(parseCliArgs(["policy", "set", "--preferred", "acc1,acc2", "--reserve", "acc3"]), {
    kind: "policy-set",
    json: false,
    preferredAliases: ["acc1", "acc2"],
    reserveAliases: ["acc3"],
    maxPrimaryUsedPercent: undefined,
    maxWeeklyUsedPercent: undefined,
  });
  assert.deepEqual(parseCliArgs(["limits", "--alias", "acc1"]), {
    kind: "show-limits",
    alias: "acc1",
    json: false,
  });
  assert.deepEqual(parseCliArgs(["sync", "--alias", "Work"]), {
    kind: "sync",
    alias: "Work",
    json: false,
  });
  assert.deepEqual(parseCliArgs(["use", "acc1"]), {
    kind: "use",
    alias: "acc1",
    json: false,
  });
  assert.deepEqual(parseCliArgs(["refresh", "tokens", "--all"]), {
    kind: "refresh-tokens",
    alias: null,
    json: false,
  });
  assert.deepEqual(parseCliArgs(["refresh", "limits", "--alias", "acc2"]), {
    kind: "refresh-limits",
    alias: "acc2",
    json: false,
  });
});

test("parseCliArgs accepts --json globally", () => {
  assert.deepEqual(parseCliArgs(["list", "--json"]), { kind: "list", json: true });
  assert.deepEqual(parseCliArgs(["--json", "policy", "show"]), {
    kind: "policy-show",
    json: true,
  });
});

test("parseCliArgs rejects invalid scoped target combinations", () => {
  assert.throws(() => parseCliArgs(["limits"]), /Choose exactly one/);
  assert.throws(
    () => parseCliArgs(["refresh", "tokens", "--all", "--alias", "acc1"]),
    /Choose exactly one/,
  );
  assert.throws(() => parseCliArgs(["refresh", "limits"]), /Choose exactly one/);
  assert.throws(() => parseCliArgs(["policy", "set"]), /requires at least one option/);
});

test("runCli prints help and exits zero", async () => {
  const capture = createIo();

  const exitCode = await runCli(["--help"], capture.io, createDeps());

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.equal(capture.getStdout(), HELP_TEXT);
});

test("runCli prints help as JSON", async () => {
  const capture = createIo();

  const exitCode = await runCli(["--help", "--json"], capture.io, createDeps());

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.deepEqual(JSON.parse(capture.getStdout()), {
    ok: true,
    command: "help",
    usage: [
      "codex-rotator list",
      "codex-rotator rotate",
      "codex-rotator policy show",
      "codex-rotator policy set --preferred <alias1,alias2> --reserve <alias3>",
      "codex-rotator policy clear",
      "codex-rotator limits --all",
      "codex-rotator limits --alias <alias>",
      "codex-rotator sync [--alias <alias>]",
      "codex-rotator use <alias>",
      "codex-rotator refresh tokens --all",
      "codex-rotator refresh tokens --alias <alias>",
      "codex-rotator refresh limits --all",
      "codex-rotator refresh limits --alias <alias>",
      "codex-rotator --help",
    ],
    commands: [
      { command: "list", description: "Show stored account aliases and account metadata" },
      { command: "rotate", description: "Activate the healthiest next stored account for the next Codex run" },
      {
        command: "policy",
        description: "Show or update persistent rotation preferences and heavy-run thresholds",
      },
      { command: "limits", description: "Show cached usage / limit data for one or all accounts" },
      { command: "sync", description: "Sync the current device auth.json into the encrypted store" },
      { command: "use", description: "Write a stored account into the live Codex auth.json on this device" },
      { command: "refresh tokens", description: "Refresh stored OAuth tokens" },
      { command: "refresh limits", description: "Refresh usage / limit windows" },
    ],
    options: [
      {
        name: "--json",
        description: "Emit machine-readable JSON to stdout; progress and errors stay on stderr",
      },
    ],
  });
});

test("runCli policy show emits JSON result", async () => {
  const capture = createIo();

  const exitCode = await runCli(
    ["policy", "show", "--json"],
    capture.io,
    createDeps({
      readRotationPolicy: async () => ({
        policy: {
          preferredAliases: ["acc1", "acc2"],
          reserveAliases: ["acc3"],
          heavyRun: {
            maxPrimaryUsedPercent: 55,
            maxWeeklyUsedPercent: 75,
          },
        },
        accounts: ["acc1", "acc2", "acc3"],
      }),
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.deepEqual(JSON.parse(capture.getStdout()), {
    ok: true,
    command: "policy-show",
    policy: {
      preferredAliases: ["acc1", "acc2"],
      reserveAliases: ["acc3"],
      heavyRun: {
        maxPrimaryUsedPercent: 55,
        maxWeeklyUsedPercent: 75,
      },
    },
    accounts: ["acc1", "acc2", "acc3"],
  });
});

test("runCli policy set emits JSON result", async () => {
  const capture = createIo();

  const exitCode = await runCli(
    [
      "policy",
      "set",
      "--preferred",
      "acc1,acc2",
      "--reserve",
      "acc3",
      "--max-primary-used-percent",
      "55",
      "--max-weekly-used-percent",
      "75",
      "--json",
    ],
    capture.io,
    createDeps({
      updateRotationPolicy: async () => ({
        store: null as never,
        policy: {
          preferredAliases: ["acc1", "acc2"],
          reserveAliases: ["acc3"],
          heavyRun: {
            maxPrimaryUsedPercent: 55,
            maxWeeklyUsedPercent: 75,
          },
        },
      }),
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.deepEqual(JSON.parse(capture.getStdout()), {
    ok: true,
    command: "policy-set",
    policy: {
      preferredAliases: ["acc1", "acc2"],
      reserveAliases: ["acc3"],
      heavyRun: {
        maxPrimaryUsedPercent: 55,
        maxWeeklyUsedPercent: 75,
      },
    },
  });
});

test("runCli rotate emits JSON result", async () => {
  const capture = createIo();

  const exitCode = await runCli(
    ["rotate", "--json"],
    capture.io,
    createDeps({
      rotateAccountOnDevice: async () => ({
        store: null as never,
        currentAlias: "acc2",
        previousAlias: "acc1",
        selectedAlias: "acc2",
        recommendedAlias: "acc1",
        reason: "fallback",
        pool: "reserve",
        changed: true,
        account: {
          alias: "acc2",
          email: "person@example.com",
          accountId: "account-2",
          planType: "pro",
          tokenExpiresAt: null,
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
          lastTokenRefreshAt: null,
          lastLimitRefreshAt: null,
          usageCount: 1,
          requiresReconnect: false,
          rawAuth: { tokens: {} },
          usage: null,
          fingerprint: "fp-2",
        },
      }),
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.deepEqual(JSON.parse(capture.getStdout()), {
    ok: true,
    command: "rotate",
    action: "switched",
    changed: true,
    reason: "fallback",
    pool: "reserve",
    previousAlias: "acc1",
    selectedAlias: "acc2",
    recommendedAlias: "acc1",
    authPath: CODEX_AUTH_PATH,
    account: {
      alias: "acc2",
      email: "person@example.com",
      accountId: "account-2",
      planType: "pro",
      tokenExpiresAt: null,
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      lastTokenRefreshAt: null,
      lastLimitRefreshAt: null,
      usageCount: 1,
      requiresReconnect: false,
      rawAuth: { tokens: {} },
      usage: null,
      fingerprint: "fp-2",
    },
  });
});

test("runCli list prints stored aliases", async () => {
  const capture = createIo();

  const exitCode = await runCli(
    ["list"],
    capture.io,
    createDeps({
      readDashboardState: async () => ({
        ...emptyState,
        accounts: [
          {
            alias: "acc1",
            email: "person@example.com",
            accountId: "account-1",
            planType: "pro",
            tokenExpiresAt: null,
            lastSyncedAt: "2026-01-01T00:00:00.000Z",
            lastTokenRefreshAt: null,
            lastLimitRefreshAt: null,
            onDevice: true,
            recommended: false,
            usageCount: 0,
            requiresReconnect: false,
            usage: null,
          },
        ],
      }),
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.match(capture.getStdout(), /acc1 \[on-device\] person@example.com pro/);
});

test("runCli list emits dashboard state as JSON", async () => {
  const capture = createIo();

  const exitCode = await runCli(
    ["list", "--json"],
    capture.io,
    createDeps({
      readDashboardState: async () => ({
        ...emptyState,
        currentAlias: "acc1",
        recommendedAlias: "acc2",
        accounts: [
          {
            alias: "acc1",
            email: "person@example.com",
            accountId: "account-1",
            planType: "pro",
            tokenExpiresAt: null,
            lastSyncedAt: "2026-01-01T00:00:00.000Z",
            lastTokenRefreshAt: null,
            lastLimitRefreshAt: null,
            onDevice: true,
            recommended: false,
            usageCount: 0,
            requiresReconnect: false,
            usage: null,
          },
        ],
      }),
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(capture.getStderr(), "");
  assert.deepEqual(JSON.parse(capture.getStdout()), {
    ok: true,
    command: "list",
    state: {
      ...emptyState,
      currentAlias: "acc1",
      recommendedAlias: "acc2",
      accounts: [
        {
          alias: "acc1",
          email: "person@example.com",
          accountId: "account-1",
          planType: "pro",
          tokenExpiresAt: null,
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
          lastTokenRefreshAt: null,
          lastLimitRefreshAt: null,
          onDevice: true,
          recommended: false,
          usageCount: 0,
          requiresReconnect: false,
          usage: null,
        },
      ],
    },
  });
});

test("runCli refresh limits emits JSON result and stderr progress", async () => {
  const capture = createIo();

  const exitCode = await runCli(
    ["refresh", "limits", "--all", "--json"],
    capture.io,
    createDeps({
      refreshAccountLimits: async (options) => {
        await options?.onProgress?.({
          total: 2,
          completed: 1,
          alias: "acc1",
          ok: true,
          message: null,
        });
        await options?.onProgress?.({
          total: 2,
          completed: 2,
          alias: "acc2",
          ok: false,
          message: "Token refresh failed (401)",
        });

        return {
          store: null as never,
          total: 2,
          completed: 2,
          failed: 1,
          errors: [{ alias: "acc2", message: "Token refresh failed (401)" }],
          refreshedAliases: ["acc1", "acc2"],
        };
      },
    }),
  );

  assert.equal(exitCode, 1);
  assert.match(capture.getStderr(), /\[1\/2\] acc1 ok/);
  assert.match(capture.getStderr(), /\[2\/2\] acc2 failed: Token refresh failed \(401\)/);
  assert.deepEqual(JSON.parse(capture.getStdout()), {
    ok: false,
    command: "refresh-limits",
    alias: null,
    total: 2,
    completed: 2,
    failed: 1,
    errors: [{ alias: "acc2", message: "Token refresh failed (401)" }],
    refreshedAliases: ["acc1", "acc2"],
  });
});

test("runCli emits JSON usage errors on stderr", async () => {
  const capture = createIo();

  const exitCode = await runCli(["limits", "--json"], capture.io, createDeps());

  assert.equal(exitCode, 2);
  assert.equal(capture.getStdout(), "");
  assert.deepEqual(JSON.parse(capture.getStderr()), {
    ok: false,
    error: {
      type: "usage",
      code: null,
      message: "Choose exactly one of --all or --alias <alias>",
    },
    exitCode: 2,
    help: {
      ok: true,
      command: "help",
      usage: [
        "codex-rotator list",
        "codex-rotator rotate",
        "codex-rotator policy show",
        "codex-rotator policy set --preferred <alias1,alias2> --reserve <alias3>",
        "codex-rotator policy clear",
        "codex-rotator limits --all",
        "codex-rotator limits --alias <alias>",
        "codex-rotator sync [--alias <alias>]",
        "codex-rotator use <alias>",
        "codex-rotator refresh tokens --all",
        "codex-rotator refresh tokens --alias <alias>",
        "codex-rotator refresh limits --all",
        "codex-rotator refresh limits --alias <alias>",
        "codex-rotator --help",
      ],
      commands: [
        { command: "list", description: "Show stored account aliases and account metadata" },
        { command: "rotate", description: "Activate the healthiest next stored account for the next Codex run" },
        {
          command: "policy",
          description: "Show or update persistent rotation preferences and heavy-run thresholds",
        },
        { command: "limits", description: "Show cached usage / limit data for one or all accounts" },
        { command: "sync", description: "Sync the current device auth.json into the encrypted store" },
        { command: "use", description: "Write a stored account into the live Codex auth.json on this device" },
        { command: "refresh tokens", description: "Refresh stored OAuth tokens" },
        { command: "refresh limits", description: "Refresh usage / limit windows" },
      ],
      options: [
        {
          name: "--json",
          description: "Emit machine-readable JSON to stdout; progress and errors stay on stderr",
        },
      ],
    },
  });
});
