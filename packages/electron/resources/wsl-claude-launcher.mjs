#!/usr/bin/env node
/**
 * WSL launcher for Claude Code (Nimbalyst).
 *
 * Invoked by the Claude Agent SDK as `pathToClaudeCodeExecutable` whenever a
 * project has opted into WSL execution mode (see wslExecutionResolver.ts).
 *
 * Why .mjs instead of .cmd:
 *   Node >= 20 refuses to spawn .cmd/.bat files without `shell: true`
 *   (CVE-2024-27980). The Claude Agent SDK does not pass `shell: true`, so
 *   a batch file would fail with EINVAL. A .mjs file is spawned via
 *   `node <launcher.mjs>` — no shell involved.
 *
 * Behavior:
 *   1. wsl.exe --cd <cwd> auto-translates a Windows-form cwd (the cwd the SDK
 *      passes to child_process.spawn) into the matching /mnt/<drive>/... path
 *      inside WSL, so the Linux-side `claude` runs with the right cwd.
 *   2. WSLENV must be set in the inherited environment (the resolver sets it
 *      explicitly). It controls which Windows-side env vars are forwarded to
 *      the Linux subprocess — the resolver uses an explicit allowlist.
 *   3. All argv tokens passed by the SDK are forwarded verbatim.
 *   4. Claude's stdio JSON protocol relies on raw byte passthrough; wsl.exe
 *      passes stdin/stdout through unmodified via `stdio: 'inherit'`.
 */

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

const proc = spawn('wsl.exe', ['--cd', process.cwd(), '--exec', 'claude', ...args], {
  stdio: 'inherit',
  windowsHide: true,
});

proc.on('error', (err) => {
  process.stderr.write(`wsl-claude-launcher: ${err.message}\n`);
  process.exit(1);
});

proc.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
