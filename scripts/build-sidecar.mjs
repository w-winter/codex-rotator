import { execSync } from "node:child_process";
import { platform, arch } from "node:os";
import { mkdirSync } from "node:fs";

function getTargetTriple() {
  const p = platform();
  const a = arch();

  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported platform: ${p}-${a}`);
}

const triple = getTargetTriple();
const ext = platform() === "win32" ? ".exe" : "";
const outfile = `src-tauri/binaries/codex-server-${triple}${ext}`;

mkdirSync("src-tauri/binaries", { recursive: true });

console.log(`Building sidecar for ${triple}...`);
console.log(`Output: ${outfile}`);

execSync(`bun build server/index.ts --compile --outfile ${outfile}`, {
  stdio: "inherit",
  env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
});

console.log("Sidecar built successfully.");
