# Codex Rotator

Codex Rotator is a local-first multi-account dashboard for the OpenAI Codex desktop experience.

It keeps multiple Codex `auth.json` sessions in an encrypted local vault, refreshes each account's usage windows, and lets you switch the active device auth without logging in and out all day.

## What it does

- Stores multiple ChatGPT/Codex account sessions locally in an encrypted vault
- Adds accounts through the first-party OAuth flow
- Reads exact primary and weekly usage windows per account
- Marks the account that is currently active in Codex
- Recommends the healthiest next account based on refreshed usage data
- Ships as a web app and a Tauri desktop app for macOS

## Local-first design

- The API only binds to `127.0.0.1`
- Stored sessions live in `~/.codex-auth-switcher/store.enc.json`
- The active device session still uses the real `~/.codex/auth.json`
- This project does not proxy Codex traffic or replace the Codex model provider

## Desktop install

Download the latest macOS build from the GitHub Releases page:

- [GitHub Releases](https://github.com/eminuckan/codex-rotator/releases)

The current release is an unsigned macOS app bundle / DMG. On first launch, macOS may ask you to confirm that you want to open it.

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

### macOS desktop build

```bash
npm run build:tauri
```

Tauri release artifacts are generated under:

```text
src-tauri/target/release/bundle/
```

## Release workflow

Pushing a tag like `v0.1.0` triggers the GitHub Actions workflow and builds a macOS release bundle.

Example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Notes

- This is an unofficial utility for local account/session management.
- Usage data availability depends on the upstream ChatGPT/Codex usage endpoints.
- If a newly added account still looks empty, use `Refresh limits` once to force a fresh read.
