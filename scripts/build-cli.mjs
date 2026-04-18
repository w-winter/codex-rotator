import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { arch, platform } from "node:os";

function getTargetTriple() {
  const currentPlatform = platform();
  const currentArch = arch();

  if (currentPlatform === "darwin" && currentArch === "arm64") return "aarch64-apple-darwin";
  if (currentPlatform === "darwin" && currentArch === "x64") return "x86_64-apple-darwin";
  if (currentPlatform === "linux" && currentArch === "x64") return "x86_64-unknown-linux-gnu";
  if (currentPlatform === "linux" && currentArch === "arm64") return "aarch64-unknown-linux-gnu";
  if (currentPlatform === "win32" && currentArch === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported platform: ${currentPlatform}-${currentArch}`);
}

const triple = getTargetTriple();
const ext = platform() === "win32" ? ".exe" : "";
const outfile = `artifacts/codex-rotator-${triple}${ext}`;

mkdirSync("artifacts", { recursive: true });

console.log(`Building CLI for ${triple}...`);
console.log(`Output: ${outfile}`);

execSync(`bun build server/cli.ts --compile --outfile ${outfile}`, {
  stdio: "inherit",
  env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
});

console.log("CLI built successfully.");
