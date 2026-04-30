/**
 * Resolves the per-project Claude execution environment.
 *
 * Returns null for the default (Windows-native) case so the existing path
 * resolution in sdkOptionsBuilder.ts continues to apply. Returns a resolution
 * object only when the project has explicitly opted into WSL mode on a
 * Windows host.
 *
 * No I/O on the hot path (the launcher path is computed from app paths once
 * per resolve call). Safe to call from sdkOptionsBuilder for every query.
 */

import * as path from 'path';
import { app } from 'electron';
import type { ClaudeExecutionResolution } from '@nimbalyst/runtime/ai/server';
import { getClaudeExecutionEnvironment } from '../../utils/aiSettingsMerge';
import { windowsToWsl } from './pathTranslation';

const WSL_LAUNCHER_BASENAME = 'wsl-claude-launcher.cmd';

/**
 * Env vars that must propagate from the Windows host into the WSL subprocess.
 * WSLENV uses /u to mark a var as "unix path style on the Linux side" — but
 * since these are scalars (not paths), /u is a no-op here and just preserves
 * the value as-is. Explicit allowlist; never use WSLENV='*' which would leak
 * arbitrary env into the subprocess.
 *
 * Keep in sync with vars set by sdkOptionsBuilder.ts. New vars added there
 * that need to reach the Linux Claude must be added here too.
 */
const WSLENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_TEAM_NAME',
  'CLAUDE_CODE_TASK_LIST_ID',
  'CLAUDE_CODE_AGENT_ID',
  'CLAUDE_CODE_AGENT_NAME',
  'CLAUDE_CODE_AGENT_TYPE',
  'CLAUDE_CODE_ENABLE_TASKS',
  'ENABLE_TOOL_SEARCH',
];

function buildWslEnv(): string {
  return WSLENV_ALLOWLIST.map((v) => `${v}/u`).join(':');
}

/**
 * Resolve the absolute path to the WSL launcher script that ships with the app.
 *
 * Dev mode: from the workspace's resources directory.
 * Packaged: from app.asar.unpacked/resources/ (the .cmd cannot live inside the
 * asar virtual filesystem because cmd.exe can't read it from there).
 */
function resolveLauncherPath(): string {
  const appPath = app.getAppPath();
  const root = appPath.includes('app.asar')
    ? appPath.replace(/app\.asar(?=[\/\\]|$)/, 'app.asar.unpacked')
    : appPath;
  return path.join(root, 'resources', WSL_LAUNCHER_BASENAME);
}

/**
 * Production resolver — call from Electron main and pass to
 * `ClaudeCodeProvider.setClaudeExecutionResolver`.
 */
export function resolveClaudeExecution(workspacePath?: string): ClaudeExecutionResolution | null {
  if (!workspacePath || process.platform !== 'win32') {
    return null;
  }

  const override = getClaudeExecutionEnvironment(workspacePath);
  if (!override || override.mode !== 'wsl') {
    return null;
  }

  return {
    mode: 'wsl',
    pathToClaudeCodeExecutable: resolveLauncherPath(),
    envOverrides: {
      WSLENV: buildWslEnv(),
    },
    distro: override.distro,
    displayLabel: override.distro ? `WSL: ${override.distro}` : 'WSL (default distro)',
    translatePath: windowsToWsl,
  };
}
