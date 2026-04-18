# Codex Rotator

Codex Rotator is a local-first multi-account dashboard and CLI for the OpenAI Codex desktop experience.

It keeps multiple Codex `auth.json` sessions in an encrypted local vault, refreshes each account's usage windows, and lets you switch the active device auth without logging in and out all day.

## What it does

- Stores multiple ChatGPT/Codex account sessions locally in an encrypted vault
- Adds accounts through the first-party OAuth flow in the dashboard
- Keeps same-email accounts separate when they belong to different subscription/account contexts
- Reads exact primary and weekly usage windows per account
- Marks the account that is currently active in Codex
- Recommends the healthiest next account based on refreshed usage data
- Ships as a web app, a Tauri desktop app for macOS, and a standalone CLI

## Local-first design

- The API only binds to `127.0.0.1`
- Stored sessions live in `~/.codex-auth-switcher/store.enc.json`
- The active device session still uses the real `~/.codex/auth.json`
- The dashboard and CLI operate on the same encrypted store and live auth file
- This project does not proxy Codex traffic or replace the Codex model provider

## Desktop install

Download the latest macOS build from the GitHub Releases page:

- [GitHub Releases](https://github.com/eminuckan/codex-rotator/releases)

The current release is an unsigned macOS app bundle / DMG. On first launch, macOS may ask you to confirm that you want to open it.

## CLI

The standalone CLI talks directly to the same local store/auth files as the dashboard. It does not require the local HTTP API to be running.

### Run from source

```bash
npm install
npm run cli -- list
npm run cli -- list --json
npm run cli -- policy show
npm run cli -- policy set --preferred biz1,biz2 --reserve pro1
npm run cli -- rotate
npm run cli -- limits --all
npm run cli -- sync
npm run cli -- use acc1
npm run cli -- refresh tokens --all
npm run cli -- refresh limits --alias acc1
```

### Install the `codex-rotator` command locally

```bash
npm install
npm link
codex-rotator list
codex-rotator list --json
codex-rotator policy show
codex-rotator rotate
codex-rotator limits --all
```

If you only want the command inside this repo without linking it globally, you can also run:

```bash
./bin/codex-rotator.mjs list
```

### Release asset

GitHub Releases also publish a standalone `codex-rotator-<target>` CLI binary alongside the DMG.

### Commands

```text
codex-rotator list
codex-rotator rotate
codex-rotator policy show
codex-rotator policy set --preferred <alias1,alias2> --reserve <alias3>
codex-rotator policy clear
codex-rotator limits --all
codex-rotator limits --alias <alias>
codex-rotator sync [--alias <alias>]
codex-rotator use <alias>
codex-rotator refresh tokens --all
codex-rotator refresh tokens --alias <alias>
codex-rotator refresh limits --all
codex-rotator refresh limits --alias <alias>
```

`list` shows the stored aliases and account metadata. `rotate` activates the healthiest next stored account for the next Codex run, using the persisted rotation policy when configured. `policy show`, `policy set`, and `policy clear` manage that policy. `limits` shows the cached usage snapshot for one or all accounts. `sync` stores the current device auth into the encrypted vault and refreshes that account's limits. `use` writes a stored account back into the live Codex `auth.json` on this device. OAuth add-account remains dashboard/browser-driven.

Pass `--json` to any CLI command to emit machine-readable JSON on stdout. In JSON mode, refresh progress and errors stay on stderr so stdout remains safe to pipe into `jq`.

```bash
codex-rotator refresh limits --all --json >/tmp/refresh.json
codex-rotator rotate --json
codex-rotator list --json | jq '.state.recommendedAlias'
```

### Rotation policy

Rotation policy is persistent and local to the encrypted store. It lets you separate normal rotation targets from reserve-only fallbacks and define what counts as safe for a heavy Codex run.

Show the current policy:

```bash
codex-rotator policy show
```

Configure two preferred business accounts and one reserve pro account:

```bash
codex-rotator policy set \
  --preferred biz1,biz2 \
  --reserve pro1 \
  --max-primary-used-percent 60 \
  --max-weekly-used-percent 80
```

With that policy in place, `rotate` behaves like this:

- it only considers preferred aliases first
- it rotates between preferred aliases when one is heavy-run-safe
- it falls back to reserve aliases only when no preferred alias is safe
- it leaves device auth unchanged when nothing matches the policy safely

Reset to the default un-tiered behavior:

```bash
codex-rotator policy clear
```

### Useful env overrides

- `CODEX_SWITCHER_HOME`
- `CODEX_SWITCHER_AUTH_PATH`
- `CODEX_SWITCHER_REFRESH_CONCURRENCY`

## Development

### Requirements

- Node.js 24+
- Bun 1.2+
- Rust stable toolchain
- Xcode Command Line Tools on macOS

### Run the web app

```bash
npm install
npm run dev
```

### Run the Tauri desktop app

```bash
npm install
npm run dev:tauri
```

## Build

### Web build

```bash
npm run build
```

### CLI build

```bash
npm run build:cli
```

CLI release artifacts are generated under:

```text
artifacts/
```

### macOS desktop build

```bash
npm run build:tauri
```

Tauri release artifacts are generated under:

```text
src-tauri/target/release/bundle/
```

## Release workflow

Pushing a tag like `v0.1.0` triggers the GitHub Actions workflow and builds both the macOS app bundle and the standalone CLI asset.

Example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Notes

- This is an unofficial utility for local account/session management.
- Usage data availability depends on the upstream ChatGPT/Codex usage endpoints.
- If a newly added account still looks empty, use `Refresh limits` once to force a fresh read.
- OAuth add-account is intentionally not exposed through the CLI in this version.
