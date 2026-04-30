# WSL Support Implementation Plan

## Goal

Add **project-level WSL support for Claude Code on Windows** so a project can run Claude either:
- Natively on Windows, or
- Inside WSL

The UI should clearly indicate:
- **Claude execution environment**: Windows native | WSL
- **Terminal shell**: PowerShell | Git Bash | WSL

## Product Model

### Project-level Claude execution setting

Add a project-specific setting for Claude Code:

```ts
claudeCode?: {
  executionEnvironment?: 'windows' | 'wsl'
}
```

- `undefined` - preserves current Windows behavior
- `windows` - runs Claude Code using the existing Windows-native flow
- `wsl` - runs Claude Code inside the default WSL distro

This setting should live in **Project Settings > AI Providers > Claude Agent**.

### Design Decision

**Do not implement "Git for Windows" as a third Claude execution backend.** Git Bash should remain a terminal/shell label, not a separate Claude runtime. This keeps the implementation simpler and matches the current provider launch model.

---

## UI Requirements

For Windows projects, display two separate labels:

| Label | Options |
|-------|---------|
| Claude execution | Windows \| WSL |
| Terminal shell | PowerShell \| Git Bash \| WSL |

This gives users clear visibility into whether Claude is running natively or through WSL, while still showing their terminal shell choice.

---

## Backend Architecture

### 1. Claude Execution Environment Resolver

Introduce a main-process resolver responsible for determining how Claude should run for a given project:

```ts
ClaudeExecutionEnvironmentResolver
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

### 2. WSL Claude Launching

The current Claude provider passes the SDK:
- Executable path
- `cwd`
- Environment variables

It does not expose an argv-prefix API to prepend `wsl.exe`. Therefore, WSL mode should use a small **Windows-side wrapper/shim** as the Claude executable:

```bash
wsl.exe --cd <translated-cwd> --exec claude ...args
```

This keeps WSL launching isolated from the rest of the Claude provider implementation.

### 3. Path Translation Utilities

Extract Windows-to-WSL path conversion into a shared utility supporting both directions:

| Direction | Example |
|-----------|---------|
| Windows → WSL | `C:\Users\name\repo` → `/mnt/c/Users/name/repo` |
| WSL → Windows | `/mnt/c/Users/name/repo` → `C:\Users\name\repo` |

Reuse this mapper across:
- Terminal integration
- Claude launch
- Claude session import/resume
- Permission and workspace identity logic

---

## State and Session Handling

### User-level vs Project-local `.claude` State

| State Type | Location | Handling |
|------------|----------|----------|
| **Project-local** | `.claude/settings*.json` in workspace | Tied to repo, shared between Windows/WSL when on mounted drive |
| **User-level** | `~/.claude/projects` | Needs WSL-aware adapter |

### WSL-aware Claude Home Adapter

A spawn-only implementation is insufficient. The following need to become environment-aware:

- Claude install checks
- Claude login/auth checks
- User environment variables
- Session scanning
- Session sync/import
- Resume behavior

---

## Environment-aware Readiness Checks

### Windows mode checks
- Claude Code for Windows installed
- Claude auth/login status valid
- Existing environment/config checks

### WSL mode checks
- `wsl.exe` is available
- A default WSL distro is installed
- `claude` is available on `PATH` inside WSL
- Claude auth works inside WSL
- Project path can be translated to a WSL path

If any check fails, show actionable diagnostics in the UI.

---

## v1 Scope

### In Scope
- Windows hosts only
- Project-level toggle between `Windows` and `WSL`
- Default WSL distro only
- Workspaces that map cleanly to `/mnt/<drive>/...`

### Deferred to Future Work
- Explicit distro selection
- `\\wsl$\...` / native ext4 workspace paths
- Advanced cross-environment migration flows
- Git Bash as a third Claude runtime

---

## Risk Areas

### 1. Session Import/Resume (Highest Risk)
Current session scanning assumes Windows-local `~/.claude/projects` layout. Will break or become inconsistent if Claude sessions are created inside WSL and scanned from Windows logic without path normalization.

### 2. Path Identity Mismatches
The same repo may appear as:
- `C:\repo\foo`
- `/mnt/c/repo/foo`

Without consistent normalization, this causes duplicate session identities, broken resume behavior, or incorrect project matching.

### 3. Install/Auth Drift
A machine may have different Claude install/auth states in Windows vs WSL. Diagnostics must clearly explain which environment is unhealthy.

### 4. Project-local vs User-level `.claude` Confusion
Without explicit separation, users may see inconsistent permissions, session history, or settings depending on execution environment.

---

## Suggested PR Breakdown

### PR 1: Project Setting and UI
- Add project-level Claude execution environment setting
- Persist and merge with existing project AI provider overrides
- Add selector to Project Settings
- Show separate UI labels for Claude execution and terminal shell

### PR 2: Execution Resolver and WSL Launch Path
- Add `ClaudeExecutionEnvironmentResolver`
- Add shared Windows/WSL path translation utilities
- Add WSL wrapper/shim for launching Claude through `wsl.exe`
- Wire resolver into Claude Code SDK option construction
- Add diagnostics for missing WSL, missing distro, missing Claude, unmappable paths

### PR 3: WSL-aware Claude State and Sessions
- Add WSL-aware Claude home/session handling
- Update session scanner/import/resume logic
- Ensure WSL sessions can be discovered and resumed
- Add integration coverage for Windows-native and WSL-backed projects

---

## Test Matrix

| Category | Test Cases |
|----------|------------|
| **Settings** | Override persistence, merge behavior |
| **UI** | Windows/WSL Claude labels, PowerShell/Git Bash/WSL shell labels |
| **Path Translation** | Windows → WSL, WSL → Windows |
| **WSL Wrapper** | Command generation |
| **Claude Launch** | Windows-native session start, WSL session start |
| **Diagnostics** | Missing WSL, missing Claude-in-WSL |
| **Sessions** | Import from Windows home, import from WSL home, resume in both modes |
