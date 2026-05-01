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
 * Behavior (two-phase):
 *   1. Resolve `claude`'s absolute Linux path via a login shell. This is the
 *      only way to honor user-local install dirs like `~/.local/bin` that get
 *      added to PATH by `~/.profile`. We tolerate dotfile noise (banners,
 *      welcome messages) by taking the LAST absolute-path line of stdout.
 *   2. Spawn claude via `wsl.exe --exec <absolutePath>`. `--exec` bypasses the
 *      user's default Linux shell, so no dotfiles run at session-spawn time.
 *      That keeps stdio clean for Claude's JSON protocol — any noise from
 *      `~/.profile`/`~/.bashrc`/`~/.zshrc` would otherwise corrupt the stream
 *      that the Claude Agent SDK parses.
 *
 *   - wsl.exe --cd <cwd> auto-translates a Windows-form cwd into the matching
 *     /mnt/<drive>/... path inside WSL.
 *   - WSLENV must be set in the inherited environment (the resolver sets it
 *     explicitly with an allowlist for forwarded vars like ANTHROPIC_API_KEY).
 *   - All argv tokens passed by the SDK are forwarded verbatim.
 *   - Claude's stdio JSON protocol relies on raw byte passthrough; wsl.exe
 *     passes stdin/stdout through unmodified via `stdio: 'inherit'`.
 */

import { spawn, spawnSync } from 'node:child_process';

// Phase 1: resolve `claude` inside WSL using a login shell so user-local PATH
// additions (e.g. ~/.local/bin from ~/.profile) are visible. Tolerate noisy
// dotfiles by extracting the last absolute-path line from stdout.
const resolved = spawnSync(
  'wsl.exe',
  ['--exec', 'bash', '-lc', 'command -v claude'],
  { encoding: 'utf8', windowsHide: true }
);

if (resolved.status !== 0) {
  process.stderr.write('wsl-claude-launcher: could not locate `claude` inside WSL.\n');
  process.stderr.write('Make sure Claude Code is installed in your default distro and on the login-shell PATH.\n');
  if (resolved.stderr) process.stderr.write(resolved.stderr);
  process.exit(1);
}

const claudePath = resolved.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .reverse()
  .find((line) => line.startsWith('/'));

if (!claudePath) {
  process.stderr.write('wsl-claude-launcher: WSL returned no absolute path for `claude`.\n');
  process.stderr.write(`stdout was:\n${resolved.stdout}`);
  process.exit(1);
}

// Phase 2: spawn claude directly via --exec. No shell in the spawn path means
// no dotfile noise can corrupt Claude's JSON-over-stdio protocol.
const args = process.argv.slice(2);

const proc = spawn(
  'wsl.exe',
  ['--cd', process.cwd(), '--exec', claudePath, ...args],
  { stdio: 'inherit', windowsHide: true }
);

proc.on('error', (err) => {
  process.stderr.write(`wsl-claude-launcher: ${err.message}\n`);
  process.exit(1);
});

proc.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
