# WSL Execution Mode — Windows validation checklist

This branch (`feature/wsl-claude-execution-mode`) was built and committed from
macOS, where the WSL execution paths cannot be exercised. Use this checklist
when picking the work back up on a Windows host with WSL installed.

Tracking issue: <https://github.com/Nimbalyst/nimbalyst/issues/26>

---

## 1. Static checks

```powershell
npm install
npm run typecheck -ws
```

The cross-package type graph hasn't been validated end-to-end. Most likely
trouble spots if anything fails:

- `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts` — the
  added `export type { ClaudeExecutionResolution, ClaudeExecutionResolver }`
  re-export must resolve from `@nimbalyst/runtime/ai/server` (used by the
  electron resolver).
- `packages/electron/src/main/services/wsl/wslExecutionResolver.ts` — uses
  `app.getAppPath()` and the `ClaudeExecutionResolution` type.

If the runtime package needs a rebuild for the new exports to flow into
`dist`, run the runtime build the same way the dev script does it (the
`exports` field in `packages/runtime/package.json` points at `./dist`).

## 2. Unit tests

```powershell
cd packages\electron
npx vitest run src/main/services/wsl/__tests__/pathTranslation.test.ts
```

These are pure-function tests for `windowsToWsl` / `wslToWindows`. They
should pass on macOS too, but they were authored without an installed
`node_modules` so worth running once before relying on them.

## 3. Smoke test the launcher

The single biggest unknown for this feature.

### Setup

1. `npm run dev` (or `npm run dev:loop`).
2. Open any project. Open Settings -> Project Settings -> AI Providers.
3. Expand the Claude Agent row. Toggle the override on. In the Claude
   Execution dropdown, pick "WSL (default distro)". Save.
4. Confirm an experimental warning banner appears under the dropdown.
5. Inside your default WSL distro, ensure a Linux Claude install is on
   the PATH:

   ```bash
   wsl.exe -- bash -lc 'which claude && claude --version'
   ```

### What to look for in `main.log`

```bash
tail -f "$LOCALAPPDATA\@nimbalyst\electron\logs\main.log"
```

Start a Claude Code session in the project. Expected lines:

```
[ClaudeCodeProvider] Initialized claudeExecutionResolver
[CLAUDE-CODE] Binary path: mode=wsl (WSL (default distro)) custom=(none) resolved=...\claude.exe effective=...\app.asar.unpacked\resources\wsl-claude-launcher.mjs
```

If `mode=wsl` does not appear, the resolver is not firing — check the
project override is saved and the workspace path resolves.

### CVE-2024-27980 (resolved)

Node >= 20 refuses to spawn `.cmd`/`.bat` files without `shell: true`, and
the Claude Agent SDK never passes `shell: true`. The original `.cmd` launcher
was replaced with `wsl-claude-launcher.mjs`. The SDK's internal `MR()` check
treats `.mjs` as a script, so it spawns `node <launcher.mjs>` rather than
the file directly — no shell needed. The `.mjs` launcher then spawns
`wsl.exe` (a real `.exe`) with `stdio: 'inherit'`.

## 4. WSLENV passthrough

Confirm the env-var allowlist actually reaches Linux Claude.

1. With WSL mode enabled for a project, set
   `CLAUDE_CODE_EFFORT_LEVEL=high` in app settings.
2. Start a session. Ask Claude to run a Bash tool that echoes the var:

   ```
   echo "$CLAUDE_CODE_EFFORT_LEVEL"
   ```

3. Output should be `high`. If it's empty, the WSLENV allowlist in
   `packages/electron/src/main/services/wsl/wslExecutionResolver.ts`
   (`WSLENV_ALLOWLIST` constant) needs adjustment, or the launcher is
   not propagating env correctly.

Also verify `ANTHROPIC_API_KEY` is forwarded if the user has a
project-level API key configured — otherwise Linux Claude won't see it.

## 5. Path translation in plugins / additionalDirectories

If the project has an extension that exposes a Claude plugin, or
`additionalDirectoriesLoader` returns any paths, those paths must reach
Linux Claude in `/mnt/<drive>/...` form.

Check `main.log` for the warning shape:

```
[CLAUDE-CODE] Dropping plugin in WSL ... mode (no translation for path): ...
```

That fires only when a path can't be translated (e.g. UNC to a non-WSL
host). For DOS paths it should silently translate — nothing to verify
beyond "no warning".

---

## Deferred work (blocked on this validation)

These are tracked as outstanding tasks (see the plan file at
`/Users/peter.souter/.claude/plans/nifty-jingling-token.md` for full
context):

### Task 5 — PR 3: session scanner + per-mode diagnostics

Files to touch:

- `packages/electron/src/main/services/ClaudeCodeSessionScanner.ts`
  - `getClaudeProjectsDir()` (line ~73) — add a mode argument; in WSL
    mode, resolve the Linux home via
    `wsl.exe -- bash -lc 'echo $HOME'` and form the UNC path
    `\\wsl$\<distro>\<linuxHome>\.claude\projects`.
  - `normalizeWorkspacePath()` (lines ~60-68) — handle `-mnt-c-...`
    escapes and round-trip through `wslToWindows()` to canonical
    Windows form so identity matching collapses
    `C:\repo\foo` and `/mnt/c/repo/foo` to one workspace.
- `packages/electron/src/main/services/ClaudeCodeDetector.ts`
  - Split `checkInstallation()` and `checkLoginStatus()` per mode.
    WSL variants run `wsl.exe -- bash -lc 'claude --version'` and
    `wsl.exe -- bash -lc 'claude -p status'`. Cache per-mode.
- `packages/electron/src/renderer/components/Settings/panels/ProjectAIProvidersPanel.tsx`
  - Surface install/auth diagnostics per mode (currently the panel
    only shows the experimental warning).

Until this ships: existing Windows-native sessions continue to work
as today; sessions started in WSL mode launch but won't appear in
import/resume lists.

### Task 6 — MCP / stdio bridge across the WSL boundary

This is the architectural risk flagged in the original review and the
gate on whether v1 is end-to-end useful.

When Claude runs inside WSL:

- **Internal MCP servers** (`httpServer`, `sessionContextServer`,
  extension dev server) run on the Windows host. They must bind on
  TCP reachable from inside WSL2 (host loopback works on most distros
  but is not guaranteed). Today they may bind on Unix-domain or
  named-pipe paths that WSL2 cannot reach.
- **Stdio MCP servers** (`npx`, `uvx`, `docker`) referenced in
  `mcpConfigService.getMcpServersConfig()` run as Claude's child
  processes — those must exist on the **Linux** PATH inside the
  distro. The MCP config currently passes a Windows-shape config; it
  needs translation or a WSL-side variant.

This is sizeable — it's not a small follow-up, it's a workstream.
Consider logging it as a tracker decision item via `tracker_create`
(can only be invoked from a running Nimbalyst dev session, not the
CLI) so the constraint is durable.

---

## Once validated, before merging

1. Either drop or rebuild `WINDOWS_DEV_MACHINE_CHECKS.md` into the
   relevant section of `docs/EXTENSION_ARCHITECTURE.md` /
   `RELEASING.md` so the steps don't get lost.
2. Add a `Configurable execution environment` row to
   `KeyboardShortcutsDialog.tsx` if any keyboard shortcut ends up
   tied to the toggle (currently none — settings UI only).
3. Update `CHANGELOG.md` `[Unreleased]` section.
