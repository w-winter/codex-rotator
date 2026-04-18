import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  AccountServiceError,
  activateAccountOnDevice,
  clearRotationPolicy,
  readDashboardState,
  readRotationPolicy,
  refreshAccountLimits,
  refreshAccountTokens,
  rotateAccountOnDevice,
  syncCurrentDeviceAuth,
  updateRotationPolicy,
} from "./lib/account-service.js";
import { CODEX_AUTH_PATH } from "./lib/config.js";
import type { DashboardAccountState, DashboardState } from "./lib/dashboard-state.js";
import type { RotationPolicy } from "./lib/types.js";

type CliCommand =
  | { kind: "help"; json: boolean }
  | { kind: "list"; json: boolean }
  | { kind: "rotate"; json: boolean }
  | { kind: "policy-show"; json: boolean }
  | {
      kind: "policy-set";
      json: boolean;
      preferredAliases?: string[];
      reserveAliases?: string[];
      maxPrimaryUsedPercent?: number;
      maxWeeklyUsedPercent?: number;
    }
  | { kind: "policy-clear"; json: boolean }
  | { kind: "show-limits"; alias: string | null; json: boolean }
  | { kind: "sync"; alias: string | null; json: boolean }
  | { kind: "use"; alias: string; json: boolean }
  | { kind: "refresh-tokens"; alias: string | null; json: boolean }
  | { kind: "refresh-limits"; alias: string | null; json: boolean };

type CliDeps = {
  syncCurrentDeviceAuth: typeof syncCurrentDeviceAuth;
  activateAccountOnDevice: typeof activateAccountOnDevice;
  refreshAccountTokens: typeof refreshAccountTokens;
  refreshAccountLimits: typeof refreshAccountLimits;
  rotateAccountOnDevice: typeof rotateAccountOnDevice;
  readRotationPolicy: typeof readRotationPolicy;
  updateRotationPolicy: typeof updateRotationPolicy;
  clearRotationPolicy: typeof clearRotationPolicy;
  readDashboardState: typeof readDashboardState;
};

type CliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

type HelpResult = { kind: "help" };
type ScopedAliasResult = HelpResult | { alias: string | null };

type HelpCommand = {
  command: string;
  description: string;
};

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const HELP_USAGE = [
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
] as const;

const HELP_COMMANDS: HelpCommand[] = [
  { command: "list", description: "Show stored account aliases and account metadata" },
  { command: "rotate", description: "Activate the healthiest next stored account for the next Codex run" },
  { command: "policy", description: "Show or update persistent rotation preferences and heavy-run thresholds" },
  { command: "limits", description: "Show cached usage / limit data for one or all accounts" },
  { command: "sync", description: "Sync the current device auth.json into the encrypted store" },
  { command: "use", description: "Write a stored account into the live Codex auth.json on this device" },
  { command: "refresh tokens", description: "Refresh stored OAuth tokens" },
  { command: "refresh limits", description: "Refresh usage / limit windows" },
];

const HELP_TEXT = `Usage:\n${HELP_USAGE.map((line) => `  ${line}`).join("\n")}\n\nCommands:\n${HELP_COMMANDS.map((entry) => `  ${entry.command.padEnd(17, " ")}${entry.description}`).join("\n")}\n\nGlobal options:\n  --json           Emit machine-readable JSON to stdout\n`;

const defaultDeps: CliDeps = {
  syncCurrentDeviceAuth,
  activateAccountOnDevice,
  refreshAccountTokens,
  refreshAccountLimits,
  rotateAccountOnDevice,
  readRotationPolicy,
  updateRotationPolicy,
  clearRotationPolicy,
  readDashboardState,
};

function extractJsonFlag(argv: string[]) {
  let json = false;
  const args = argv.filter((arg) => {
    if (arg === "--json") {
      json = true;
      return false;
    }

    return true;
  });

  return { args, json };
}

function parseScopedAliasArgs(argv: string[]): ScopedAliasResult {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      alias: { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (parsed.values.help) {
    return { kind: "help" };
  }

  const alias = parsed.values.alias ?? null;
  const all = parsed.values.all === true;
  if (all === (alias !== null)) {
    throw new CliUsageError("Choose exactly one of --all or --alias <alias>");
  }

  return { alias: all ? null : alias };
}

function parseNoArgsCommand<T extends "list" | "rotate">(
  argv: string[],
  name: T,
): HelpResult | { kind: T } {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (parsed.values.help) {
    return { kind: "help" };
  }

  if (argv.length > 0) {
    throw new CliUsageError(`${name} does not take any arguments`);
  }

  return { kind: name };
}

function normalizeArgTail(subcommand: string | undefined, rest: string[]) {
  return subcommand ? [subcommand, ...rest] : rest;
}

function parseAliasCsv(input: string) {
  return input
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function parseOptionalPercent(input: string | undefined, name: string) {
  if (input == null) {
    return undefined;
  }

  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new CliUsageError(`${name} must be a number`);
  }

  return value;
}

function parsePolicySetArgs(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      preferred: { type: "string" },
      reserve: { type: "string" },
      "max-primary-used-percent": { type: "string" },
      "max-weekly-used-percent": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (parsed.values.help) {
    return { kind: "help" } as const;
  }

  const preferredAliases = parsed.values.preferred === undefined
    ? undefined
    : parseAliasCsv(parsed.values.preferred);
  const reserveAliases = parsed.values.reserve === undefined
    ? undefined
    : parseAliasCsv(parsed.values.reserve);
  const maxPrimaryUsedPercent = parseOptionalPercent(
    parsed.values["max-primary-used-percent"],
    "max-primary-used-percent",
  );
  const maxWeeklyUsedPercent = parseOptionalPercent(
    parsed.values["max-weekly-used-percent"],
    "max-weekly-used-percent",
  );

  if (
    preferredAliases === undefined &&
    reserveAliases === undefined &&
    maxPrimaryUsedPercent === undefined &&
    maxWeeklyUsedPercent === undefined
  ) {
    throw new CliUsageError("policy set requires at least one option to update");
  }

  return {
    preferredAliases,
    reserveAliases,
    maxPrimaryUsedPercent,
    maxWeeklyUsedPercent,
  };
}

function formatPercent(value: number | null) {
  if (value == null) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatMaybe(value: string | null) {
  return value ?? "-";
}

function formatTags(account: DashboardAccountState) {
  const tags: string[] = [];
  if (account.onDevice) tags.push("on-device");
  if (account.recommended) tags.push("recommended");
  return tags.length > 0 ? ` [${tags.join(", ")}]` : "";
}

function formatCredits(account: DashboardAccountState) {
  const credits = account.usage?.credits;
  if (!credits) return "n/a";
  if (credits.unlimited) return "unlimited";

  const details: string[] = [];
  if (credits.balance) details.push(`balance ${credits.balance}`);
  if (credits.approxLocalMessages != null) details.push(`local ~${credits.approxLocalMessages}`);
  if (credits.approxCloudMessages != null) details.push(`cloud ~${credits.approxCloudMessages}`);
  return details.length > 0 ? details.join(", ") : credits.hasCredits ? "available" : "none";
}

function selectAccounts(state: DashboardState, alias: string | null) {
  const accounts = alias
    ? state.accounts.filter((account) => account.alias === alias)
    : state.accounts;

  if (accounts.length === 0) {
    if (alias) {
      throw new AccountServiceError("ACCOUNT_NOT_FOUND", "Account not found");
    }

    throw new AccountServiceError("NO_MATCHING_ACCOUNTS", "No matching accounts found");
  }

  return accounts;
}

function renderAccountList(state: DashboardState) {
  if (state.accounts.length === 0) {
    return "No stored accounts\n";
  }

  return state.accounts
    .map(
      (account) =>
        `${account.alias}${formatTags(account)} ${formatMaybe(account.email)} ${formatMaybe(account.planType)}`,
    )
    .join("\n") + "\n";
}

function renderLimitBlock(account: DashboardAccountState) {
  const usage = account.usage;
  const lines = [
    `${account.alias}${formatTags(account)}`,
    `  email: ${formatMaybe(account.email)}`,
    `  plan: ${formatMaybe(account.planType)}`,
    `  refreshed: ${formatMaybe(account.lastLimitRefreshAt)}`,
  ];

  if (!usage) {
    lines.push("  limits: no cached usage data; run `refresh limits`");
    return lines.join("\n");
  }

  if (usage.error) {
    lines.push(`  error: ${usage.error}`);
  }

  lines.push(`  primary: ${formatPercent(usage.rateLimit?.primaryWindow?.usedPercent ?? null)}`);
  lines.push(`  weekly: ${formatPercent(usage.rateLimit?.secondaryWindow?.usedPercent ?? null)}`);
  lines.push(
    `  code review primary: ${formatPercent(usage.codeReviewRateLimit?.primaryWindow?.usedPercent ?? null)}`,
  );
  lines.push(
    `  code review weekly: ${formatPercent(usage.codeReviewRateLimit?.secondaryWindow?.usedPercent ?? null)}`,
  );
  lines.push(`  credits: ${formatCredits(account)}`);
  return lines.join("\n");
}

function renderLimits(state: DashboardState, alias: string | null) {
  return `${selectAccounts(state, alias).map((account) => renderLimitBlock(account)).join("\n\n")}\n`;
}

function renderRotationPolicy(policy: RotationPolicy, accounts: string[]) {
  const managedAliases = [...new Set([...policy.preferredAliases, ...policy.reserveAliases])];

  return [
    `preferred aliases: ${policy.preferredAliases.length > 0 ? policy.preferredAliases.join(", ") : "-"}`,
    `reserve aliases: ${policy.reserveAliases.length > 0 ? policy.reserveAliases.join(", ") : "-"}`,
    `heavy-run max primary used: ${policy.heavyRun.maxPrimaryUsedPercent}%`,
    `heavy-run max weekly used: ${policy.heavyRun.maxWeeklyUsedPercent}%`,
    `managed aliases: ${managedAliases.length > 0 ? managedAliases.join(", ") : "all healthy accounts"}`,
    `known aliases: ${accounts.length > 0 ? accounts.join(", ") : "-"}`,
  ].join("\n") + "\n";
}

function helpJson() {
  return {
    ok: true,
    command: "help",
    usage: [...HELP_USAGE],
    commands: HELP_COMMANDS,
    options: [
      {
        name: "--json",
        description: "Emit machine-readable JSON to stdout; progress and errors stay on stderr",
      },
    ],
  };
}

function writeJson(stream: CliIo["stdout"] | CliIo["stderr"], value: unknown) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonError(
  stream: CliIo["stderr"],
  error: {
    type: "usage" | "service" | "unexpected";
    message: string;
    code?: string;
    exitCode: number;
    help?: ReturnType<typeof helpJson>;
  },
) {
  writeJson(stream, {
    ok: false,
    error: {
      type: error.type,
      code: error.code ?? null,
      message: error.message,
    },
    exitCode: error.exitCode,
    help: error.help ?? null,
  });
}

export function parseCliArgs(argv: string[]): CliCommand {
  const { args, json } = extractJsonFlag(argv);

  if (args.length === 0) {
    return { kind: "help", json };
  }

  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)) {
    return { kind: "help", json };
  }

  const [command, subcommand, ...rest] = args;
  const tail = normalizeArgTail(subcommand, rest);

  if (command === "list") {
    const parsed = parseNoArgsCommand(tail, "list");
    return "kind" in parsed && parsed.kind === "help"
      ? { kind: "help", json }
      : { kind: "list", json };
  }

  if (command === "rotate") {
    const parsed = parseNoArgsCommand(tail, "rotate");
    return "kind" in parsed && parsed.kind === "help"
      ? { kind: "help", json }
      : { kind: "rotate", json };
  }

  if (command === "policy") {
    if (subcommand == null) {
      return { kind: "policy-show", json };
    }

    if (["--help", "-h", "help"].includes(subcommand)) {
      return { kind: "help", json };
    }

    if (subcommand === "show") {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: false,
        options: { help: { type: "boolean", short: "h" } },
        strict: true,
      });

      return parsed.values.help ? { kind: "help", json } : { kind: "policy-show", json };
    }

    if (subcommand === "clear") {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: false,
        options: { help: { type: "boolean", short: "h" } },
        strict: true,
      });

      return parsed.values.help ? { kind: "help", json } : { kind: "policy-clear", json };
    }

    if (subcommand === "set") {
      const parsed = parsePolicySetArgs(rest);
      if ("kind" in parsed) {
        return { kind: "help", json };
      }

      return { kind: "policy-set", json, ...parsed };
    }

    throw new CliUsageError(`Unknown command: ${args.join(" ")}`);
  }

  if (command === "limits") {
    const parsed = parseScopedAliasArgs(tail);
    if ("kind" in parsed) {
      return { kind: "help", json };
    }

    return { kind: "show-limits", alias: parsed.alias, json };
  }

  if (command === "sync") {
    const parsed = parseArgs({
      args: tail,
      allowPositionals: false,
      options: {
        alias: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });

    if (parsed.values.help) {
      return { kind: "help", json };
    }

    return { kind: "sync", alias: parsed.values.alias ?? null, json };
  }

  if (command === "use") {
    const parsed = parseArgs({
      args: tail,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });

    if (parsed.values.help) {
      return { kind: "help", json };
    }

    if (parsed.positionals.length !== 1) {
      throw new CliUsageError("use requires exactly one <alias>");
    }

    return { kind: "use", alias: parsed.positionals[0]!, json };
  }

  if (command === "refresh" && subcommand === "tokens") {
    const parsed = parseScopedAliasArgs(rest);
    if ("kind" in parsed) {
      return { kind: "help", json };
    }

    return { kind: "refresh-tokens", alias: parsed.alias, json };
  }

  if (command === "refresh" && subcommand === "limits") {
    const parsed = parseScopedAliasArgs(rest);
    if ("kind" in parsed) {
      return { kind: "help", json };
    }

    return { kind: "refresh-limits", alias: parsed.alias, json };
  }

  throw new CliUsageError(`Unknown command: ${args.join(" ")}`);
}

export async function runCli(
  argv: string[],
  io: CliIo = process,
  deps: CliDeps = defaultDeps,
): Promise<number> {
  try {
    const command = parseCliArgs(argv);

    if (command.kind === "help") {
      if (command.json) {
        writeJson(io.stdout, helpJson());
      } else {
        io.stdout.write(HELP_TEXT);
      }
      return 0;
    }

    if (command.kind === "list") {
      const state = await deps.readDashboardState();
      if (command.json) {
        writeJson(io.stdout, { ok: true, command: "list", state });
      } else {
        io.stdout.write(renderAccountList(state));
      }
      return 0;
    }

    if (command.kind === "rotate") {
      const result = await deps.rotateAccountOnDevice();
      if (command.json) {
        writeJson(io.stdout, {
          ok: true,
          command: "rotate",
          action: result.changed ? "switched" : result.selectedAlias ? "kept-current" : "no-eligible-account",
          changed: result.changed,
          reason: result.reason,
          pool: result.pool,
          previousAlias: result.previousAlias,
          selectedAlias: result.selectedAlias,
          recommendedAlias: result.recommendedAlias,
          authPath: CODEX_AUTH_PATH,
          account: result.account,
        });
      } else if (result.changed && result.selectedAlias) {
        if (result.reason === "fallback") {
          io.stdout.write(`Activated reserve account ${result.selectedAlias} on this device (${CODEX_AUTH_PATH})\n`);
        } else if (result.previousAlias) {
          io.stdout.write(
            `Rotated from ${result.previousAlias} to ${result.selectedAlias} on this device (${CODEX_AUTH_PATH})\n`,
          );
        } else {
          io.stdout.write(`Activated ${result.selectedAlias} on this device (${CODEX_AUTH_PATH})\n`);
        }
      } else if (result.selectedAlias) {
        io.stdout.write(`Kept ${result.selectedAlias} on this device (${CODEX_AUTH_PATH})\n`);
      } else {
        io.stdout.write("No heavy-run-safe stored account matched the current policy; leaving device auth unchanged\n");
      }
      return 0;
    }

    if (command.kind === "policy-show") {
      const result = await deps.readRotationPolicy();
      if (command.json) {
        writeJson(io.stdout, { ok: true, command: "policy-show", policy: result.policy, accounts: result.accounts });
      } else {
        io.stdout.write(renderRotationPolicy(result.policy, result.accounts));
      }
      return 0;
    }

    if (command.kind === "policy-set") {
      const result = await deps.updateRotationPolicy({
        preferredAliases: command.preferredAliases,
        reserveAliases: command.reserveAliases,
        maxPrimaryUsedPercent: command.maxPrimaryUsedPercent,
        maxWeeklyUsedPercent: command.maxWeeklyUsedPercent,
      });
      if (command.json) {
        writeJson(io.stdout, { ok: true, command: "policy-set", policy: result.policy });
      } else {
        io.stdout.write(renderRotationPolicy(result.policy, result.store.accounts.map((account) => account.alias)));
      }
      return 0;
    }

    if (command.kind === "policy-clear") {
      const result = await deps.clearRotationPolicy();
      if (command.json) {
        writeJson(io.stdout, { ok: true, command: "policy-clear", policy: result.policy });
      } else {
        io.stdout.write(renderRotationPolicy(result.policy, result.store.accounts.map((account) => account.alias)));
      }
      return 0;
    }

    if (command.kind === "show-limits") {
      const state = await deps.readDashboardState();
      if (command.json) {
        writeJson(io.stdout, {
          ok: true,
          command: "limits",
          alias: command.alias,
          currentAlias: state.currentAlias,
          recommendedAlias: state.recommendedAlias,
          accounts: selectAccounts(state, command.alias),
        });
      } else {
        io.stdout.write(renderLimits(state, command.alias));
      }
      return 0;
    }

    if (command.kind === "sync") {
      const result = await deps.syncCurrentDeviceAuth({ preferredAlias: command.alias });
      if (command.json) {
        writeJson(io.stdout, {
          ok: true,
          command: "sync",
          alias: result.alias,
          created: result.created,
          matchReason: result.matchReason,
          account: result.account,
          warning: result.account.usage?.error ?? null,
        });
      } else {
        io.stdout.write(
          `Synced device auth into ${result.alias} (${result.created ? "created" : "updated"})\n`,
        );

        if (result.account.usage?.error) {
          io.stderr.write(`Warning: limit refresh failed for ${result.alias}: ${result.account.usage.error}\n`);
        }
      }

      return 0;
    }

    if (command.kind === "use") {
      const result = await deps.activateAccountOnDevice(command.alias);
      if (command.json) {
        writeJson(io.stdout, {
          ok: true,
          command: "use",
          alias: result.account.alias,
          account: result.account,
          authPath: CODEX_AUTH_PATH,
        });
      } else {
        io.stdout.write(`Activated ${result.account.alias} on this device (${CODEX_AUTH_PATH})\n`);
      }
      return 0;
    }

    if (command.kind === "refresh-tokens") {
      const result = await deps.refreshAccountTokens({ alias: command.alias });
      if (command.json) {
        writeJson(io.stdout, {
          ok: true,
          command: "refresh-tokens",
          alias: command.alias,
          refreshedAliases: result.refreshedAliases,
        });
      } else {
        io.stdout.write(
          `Refreshed tokens for ${result.refreshedAliases.length} account${result.refreshedAliases.length === 1 ? "" : "s"}\n`,
        );
      }
      return 0;
    }

    const result = await deps.refreshAccountLimits({
      alias: command.alias,
      onProgress:
        command.alias === null
          ? async (event) => {
              const line = `[${event.completed}/${event.total}] ${event.alias} ${event.ok ? "ok" : `failed: ${event.message ?? "Limit refresh failed"}`}\n`;
              if (command.json) {
                io.stderr.write(line);
              } else {
                io.stdout.write(line);
              }
            }
          : undefined,
    });

    if (command.json) {
      writeJson(io.stdout, {
        ok: result.failed === 0,
        command: "refresh-limits",
        alias: command.alias,
        total: result.total,
        completed: result.completed,
        failed: result.failed,
        errors: result.errors,
        refreshedAliases: result.refreshedAliases,
      });
      return result.failed > 0 ? 1 : 0;
    }

    if (command.alias !== null) {
      const alias = result.refreshedAliases[0] ?? command.alias;
      if (result.failed > 0) {
        io.stderr.write(
          `Limit refresh failed for ${alias}: ${result.errors[0]?.message ?? "Unknown error"}\n`,
        );
        return 1;
      }

      io.stdout.write(`Refreshed limits for ${alias}\n`);
      return 0;
    }

    io.stdout.write(
      `Refreshed limits for ${result.total} account${result.total === 1 ? "" : "s"}: ${result.total - result.failed} succeeded, ${result.failed} failed\n`,
    );
    return result.failed > 0 ? 1 : 0;
  } catch (error) {
    const json = argv.includes("--json");

    if (error instanceof CliUsageError) {
      if (json) {
        writeJsonError(io.stderr, {
          type: "usage",
          message: error.message,
          exitCode: 2,
          help: helpJson(),
        });
      } else {
        io.stderr.write(`${error.message}\n\n${HELP_TEXT}`);
      }
      return 2;
    }

    if (error instanceof AccountServiceError) {
      if (json) {
        writeJsonError(io.stderr, {
          type: "service",
          code: error.code,
          message: error.message,
          exitCode: 1,
        });
      } else {
        io.stderr.write(`${error.message}\n`);
      }
      return 1;
    }

    if (error instanceof Error) {
      if (json) {
        writeJsonError(io.stderr, {
          type: "unexpected",
          message: error.message,
          exitCode: 1,
        });
      } else {
        io.stderr.write(`${error.message}\n`);
      }
      return 1;
    }

    if (json) {
      writeJsonError(io.stderr, {
        type: "unexpected",
        message: "Unknown error",
        exitCode: 1,
      });
    } else {
      io.stderr.write("Unknown error\n");
    }
    return 1;
  }
}

async function main() {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

export { CliUsageError, HELP_TEXT };
