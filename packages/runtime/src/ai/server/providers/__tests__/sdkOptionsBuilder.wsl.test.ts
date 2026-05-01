/**
 * WSL execution-mode propagation tests for sdkOptionsBuilder.
 *
 * Regression coverage for the Codex adversarial-review finding: when a project
 * has opted into WSL execution mode, the lead session uses the WSL launcher
 * via `effectivePath`, but packaged teammates were still being handed
 * `customPath || resolvedBinaryPath` (the Windows-native binary). That split
 * the lead and teammate execution environments — the lead ran inside WSL while
 * teammates ran the Windows binary — silently corrupting cwd/session/tool
 * routing on packaged Windows builds with Agent Teams enabled.
 *
 * The fix populates `teammateManager.packagedBuildOptions.pathToClaudeCodeExecutable`
 * with `effectivePath` and forwards the full `executionResolution` so teammates
 * can apply the same path translation the lead does for additionalDirectories.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isPackagedRef = { value: true };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackagedRef.value;
    },
  },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => 'C:\\Program Files\\claude\\claude.exe',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => 'C:\\Program Files\\claude\\claude.exe',
}));

import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';

function makeDeps(overrides: Partial<Parameters<typeof buildSdkOptions>[0]> = {}) {
  return {
    resolveModelVariant: () => 'opus',
    mcpConfigService: { getMcpServersConfig: async () => ({}) },
    createCanUseToolHandler: () => () => true,
    toolHooksService: {
      createPreToolUseHook: () => () => ({}),
      createPostToolUseHook: () => () => ({}),
    },
    teammateManager: {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    },
    sessions: { getSessionId: () => null },
    config: {},
    abortController: new AbortController(),
    ...overrides,
  } as Parameters<typeof buildSdkOptions>[0];
}

function makeParams(overrides: Partial<Parameters<typeof buildSdkOptions>[1]> = {}) {
  return {
    message: 'hello',
    workspacePath: 'C:\\Users\\dev\\workspace',
    settingsEnv: {},
    shellEnv: {},
    systemPrompt: '',
    currentMode: undefined,
    imageContentBlocks: [],
    documentContentBlocks: [],
    ...overrides,
  } as Parameters<typeof buildSdkOptions>[1];
}

const wslResolution = {
  mode: 'wsl' as const,
  pathToClaudeCodeExecutable: 'C:\\app\\resources\\wsl-claude-launcher.mjs',
  envOverrides: { WSLENV: 'ANTHROPIC_API_KEY/u' },
  distro: 'Ubuntu',
  displayLabel: 'WSL: Ubuntu',
  translatePath: (p: string) => {
    const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!m) return null;
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  },
};

describe('buildSdkOptions WSL execution propagation', () => {
  beforeEach(() => {
    isPackagedRef.value = true;
    ClaudeCodeDeps.setClaudeExecutionResolver(null);
    ClaudeCodeDeps.setCustomClaudeCodePathLoader(null);
  });

  afterEach(() => {
    ClaudeCodeDeps.setClaudeExecutionResolver(null);
    ClaudeCodeDeps.setCustomClaudeCodePathLoader(null);
  });

  it('uses the WSL launcher path on the lead options', async () => {
    ClaudeCodeDeps.setClaudeExecutionResolver(() => wslResolution);

    const { options } = await buildSdkOptions(makeDeps(), makeParams());

    expect(options.pathToClaudeCodeExecutable).toBe(wslResolution.pathToClaudeCodeExecutable);
  });

  it('hands teammates the same WSL launcher path the lead is using', async () => {
    ClaudeCodeDeps.setClaudeExecutionResolver(() => wslResolution);

    const teammateManager = {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    };

    await buildSdkOptions(makeDeps({ teammateManager }), makeParams());

    expect(teammateManager.packagedBuildOptions).toBeDefined();
    expect(teammateManager.packagedBuildOptions.pathToClaudeCodeExecutable).toBe(
      wslResolution.pathToClaudeCodeExecutable
    );
    expect(teammateManager.packagedBuildOptions.executionResolution).toBe(wslResolution);
  });

  it('falls back to native binary path for teammates when no execution override is set', async () => {
    ClaudeCodeDeps.setClaudeExecutionResolver(null);

    const teammateManager = {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    };

    await buildSdkOptions(makeDeps({ teammateManager }), makeParams());

    expect(teammateManager.packagedBuildOptions.pathToClaudeCodeExecutable).toBe(
      'C:\\Program Files\\claude\\claude.exe'
    );
    expect(teammateManager.packagedBuildOptions.executionResolution).toBeNull();
  });

  it('still populates packagedBuildOptions in unpackaged dev builds when WSL is selected', async () => {
    isPackagedRef.value = false;
    ClaudeCodeDeps.setClaudeExecutionResolver(() => wslResolution);

    const teammateManager = {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    };

    await buildSdkOptions(makeDeps({ teammateManager }), makeParams());

    expect(teammateManager.packagedBuildOptions).toBeDefined();
    expect(teammateManager.packagedBuildOptions.pathToClaudeCodeExecutable).toBe(
      wslResolution.pathToClaudeCodeExecutable
    );
  });

  it('skips packagedBuildOptions in unpackaged dev builds when no WSL override is set', async () => {
    isPackagedRef.value = false;
    ClaudeCodeDeps.setClaudeExecutionResolver(null);

    const teammateManager = {
      resolveTeamContext: async () => undefined,
      packagedBuildOptions: undefined as any,
    };

    await buildSdkOptions(makeDeps({ teammateManager }), makeParams());

    expect(teammateManager.packagedBuildOptions).toBeUndefined();
  });

  it('forwards executionResolution to mcpConfigService so stdio configs can be translated', async () => {
    ClaudeCodeDeps.setClaudeExecutionResolver(() => wslResolution);

    const getMcpServersConfig = vi.fn(async () => ({}));

    await buildSdkOptions(
      makeDeps({ mcpConfigService: { getMcpServersConfig } }),
      makeParams()
    );

    expect(getMcpServersConfig).toHaveBeenCalledWith(
      expect.objectContaining({ executionResolution: wslResolution })
    );
  });
});
