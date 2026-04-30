# WSL Support for Nimbalyst

## Summary

Add **project-level WSL support for Claude Code on Windows** so a project can run Claude either:
- Natively on Windows, or
- Inside WSL

The UI should clearly indicate:
- **Claude execution environment**: Windows native | WSL
- **Terminal shell**: PowerShell | Git Bash | WSL

This should be implemented as a **project-scoped Claude execution mode**, not a global app mode.

---

## Problem

Today, Windows support is oriented around running Claude Code natively on Windows. Nimbalyst already has:
- Project-level AI provider overrides
- Terminal shell detection for `git-bash` and `wsl`
- Windows → WSL cwd translation for terminal sessions

What is missing:
- A project-level way to tell Claude to run in WSL
- A Claude-specific execution abstraction for Windows vs WSL
- Environment-aware handling of `.claude` state, session scanning, and diagnostics

---

## Goals

- Add a **project-level Claude execution environment** setting on Windows
- Allow Claude Code to run either natively on Windows or inside WSL
- Keep terminal shell selection separate from Claude execution mode
- Show clear UI state for both execution environment and shell
- Preserve existing Windows-native behavior as the default
- Support session start, resume, and import for WSL-backed Claude projects

---

## Non-Goals

- Do not add a separate "Git for Windows" Claude runtime
- Do not add multi-distro WSL selection in v1
- Do not support every possible Linux filesystem layout in v1
- Do not redesign all global Claude settings as part of this work
- Do not build full migration tooling between Windows and WSL Claude homes beyond what is needed for basic continuity

---

## Product Proposal

### Project-level Claude Execution Setting

Add a project-level setting under **Project Settings > AI Providers > Claude Agent**:

```ts
claudeCode?: {
  executionEnvironment?: 'windows' | 'wsl'
}
```

- `undefined` - preserves current Windows behavior
- `windows` - runs Claude Code using the existing Windows-native flow
- `wsl` - runs Claude Code inside the default WSL distro

This should be stored as part of project AI provider overrides.

### UI Model

Show **two separate pieces of state** for Windows projects:

| Label | Options |
|-------|---------|
| Claude execution | Windows \| WSL |
| Terminal shell | PowerShell \| Git Bash \| WSL |

This avoids conflating shell choice with Claude runtime choice and gives users clear visibility into whether Claude is running natively or through WSL.

### Why Git Bash Should Not Be a Third Runtime

Git Bash should remain a shell/compatibility label, not a separate Claude backend.

Reasons:
- Terminal shell and Claude execution are different concerns
- Current terminal support already models Git Bash and WSL at the shell level
- Current Claude startup path is better modeled as a runtime choice between Windows and WSL
- This keeps the implementation simpler and matches the current provider launch model

---

## Technical Design

### 1. Add a Project-scoped Claude Execution Override

Extend project AI provider settings with a Claude-specific execution override.

Requirements:
- Optional field
- Defaults to current behavior when unset
- Merged through existing project override logic
- Persisted through the existing project AI settings storage path

### 2. Introduce a Claude Execution Environment Resolver

Add a central resolver in the main process to determine how Claude should run for a given project:

```ts
resolveClaudeExecutionEnvironment(projectPath, projectSettings) => {
  mode,
  executablePath,
  cwd,
  env,
  diagnostics,
  displayMetadata
}
```

**Inputs:**
- `workspacePath`
- Project Claude Code override/settings
- Current OS/platform state

**Outputs:**
- Effective execution mode: `windows` or `wsl`
- Translated working directory
- Executable path
- Environment variables
- Diagnostics
- Display metadata for the UI

This keeps Windows-vs-WSL logic in one place instead of scattering it across provider startup, session import, and settings UI.

### 3. Launch Claude Through a WSL-aware Wrapper

The current Claude provider flow is built around:
- Executable path
- `cwd`
- Environment variables

It does not expose an argv-prefix API to prepend `wsl.exe`. Therefore, WSL mode needs a small **Windows-side wrapper/shim** that can:
- Accept the Claude SDK arguments
- Translate cwd to WSL form
- Invoke `wsl.exe`
- Run Linux Claude inside WSL

Conceptually:

```bash
wsl.exe --cd <translated-cwd> --exec claude ...args
```

This is cleaner than threading WSL-specific launch behavior through every Claude provider callsite.

### 4. Extract Shared Windows/WSL Path Translation Utilities

Nimbalyst already has Windows → WSL translation for terminal sessions. That logic should be extracted into a shared utility and extended to support both directions:

| Direction | Example |
|-----------|---------|
| Windows → WSL | `C:\Users\name\repo` → `/mnt/c/Users/name/repo` |
| WSL → Windows | `/mnt/c/Users/name/repo` → `C:\Users\name\repo` |

This shared mapper should be reused by:
- Terminal sessions
- Claude launch
- Session scanning/import
- Project/session matching logic

This is important to prevent the same repo from being treated as two different workspaces.

### 5. Make `.claude` State Environment-aware

This is the highest-risk part of the work. We need to separate **project-local** Claude state from **user-level** Claude state.

#### Project-local State

Keep project-local `.claude/settings*.json` associated with the project workspace as it exists today. That keeps permissions and project settings tied to the repo and aligned between Windows and WSL when the repo lives on a mounted drive.

#### User-level State

Make user-level `.claude` access environment-aware:
- Windows execution uses Windows user Claude state
- WSL execution uses WSL user Claude state

This affects:
- Install checks
- Auth/login checks
- Environment variable reads
- Session scanning/import
- Any assumptions rooted in `os.homedir()/.claude`

### 6. Update Session Scanning and Resume/Import

Session handling is a likely regression point because current logic assumes a Windows-local Claude home.

For WSL execution we need:
- WSL-aware Claude home resolution
- Path normalization between WSL and Windows workspace paths
- Consistent project identity matching for imported/resumed sessions

This needs to work for:
- Starting a new WSL-backed Claude session
- Discovering existing WSL-backed sessions
- Resuming/importing those sessions from the desktop app

### 7. Make Readiness/Install Diagnostics Environment-aware

Current Windows guidance is focused on native Windows setup.

#### Windows Mode Checks
- Claude Code for Windows installed
- Claude auth/login status valid
- Existing environment/config checks

#### WSL Mode Checks
- `wsl.exe` is available
- A default WSL distro is installed
- `claude` is available on `PATH` inside WSL
- Claude auth works inside WSL
- Project path can be translated to a WSL path

If any check fails, show actionable diagnostics in the UI based on the selected execution environment.

---

## v1 Scope

### In Scope
- Windows hosts only
- Project-level toggle between `Windows` and `WSL`
- Default WSL distro only
- Workspaces that map cleanly to `/mnt/<drive>/...`

### Deferred to Future Work
- Selecting among multiple WSL distros
- Native ext4 / `\\wsl$\...` workspace paths
- Git Bash as a separate Claude backend
- Broad cross-environment migration tooling

---

## Risks

### 1. Session Import/Resume (Highest Risk)
Current session scanning assumes Windows-local `~/.claude/projects` layout. WSL-backed sessions may fail to appear or match correctly unless session storage and workspace path normalization are updated.

### 2. Path Identity Mismatches
The same repo may appear as:
- `C:\repo\foo`
- `/mnt/c/repo/foo`

If Windows and WSL paths are not normalized consistently, the same project may appear as two different workspaces, causing duplicate sessions or failed resume behavior.

### 3. Install/Auth Drift
A machine may have different Claude install/auth states in Windows vs WSL. Diagnostics must clearly explain which environment is unhealthy.

### 4. Shell Mode vs Execution Mode Confusion
If the UI does not separate these clearly, users may assume Git Bash means Claude is running in Linux, or that WSL shell selection alone changes Claude execution.

---

## Rollout Plan

### PR 1: Settings and UI
- Add project-level Claude execution environment setting
- Persist and merge it through project AI settings
- Show both Claude execution mode and terminal shell mode in UI

### PR 2: Runtime Execution Support
- Add Claude execution environment resolver
- Add WSL wrapper/shim for Claude launch
- Extract shared Windows/WSL path translation utilities
- Wire Claude provider startup to the resolved execution mode

### PR 3: State, Sessions, and Diagnostics
- Make user-level `.claude` access environment-aware
- Update session scan/import/resume logic for WSL
- Add environment-aware readiness/install/auth diagnostics
- Add Windows integration coverage for both execution modes

---

## Test Plan

Minimum validation for initial rollout:

| Category | Test Cases |
|----------|------------|
| **Settings** | Project setting persists correctly; merges correctly with existing AI provider overrides |
| **UI** | Windows/WSL Claude execution labels; PowerShell/Git Bash/WSL terminal shell labels displayed separately |
| **Path Translation** | Windows → WSL translation works; WSL → Windows translation works |
| **WSL Wrapper** | Command generation correct |
| **Claude Launch** | Windows-native session start still works; WSL session start works |
| **Diagnostics** | Missing WSL produces clear diagnostics; missing Linux Claude in WSL produces clear diagnostics |
| **Sessions** | Windows-native session scanning/import still works; WSL-backed session scanning/import works; switching between Windows and WSL does not corrupt project-local `.claude` settings |

---

## Recommended Decision

Implement this as:
- **Project-level Claude execution mode**
- **Windows and WSL as the only Claude execution backends**
- **Terminal shell shown separately**
- **Git Bash kept as a shell label, not a Claude runtime**

This gives the smallest implementation that matches the feature request, fits the current architecture, and avoids unnecessary complexity.

---

## Open Questions

1. Should the project setting default to explicit `windows` on Windows, or remain unset and inherit current behavior?
2. Do we want to surface a migration hint when a project is switched from Windows-native Claude to WSL Claude?
3. Is default-distro-only acceptable for v1, or do we want to reserve schema space now for future per-project distro selection?
