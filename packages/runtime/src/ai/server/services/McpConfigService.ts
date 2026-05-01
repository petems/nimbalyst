/**
 * McpConfigService - Manages MCP server configuration for AI providers
 *
 * This service handles:
 * - Loading MCP servers from user config (~/.config/claude/mcp.json)
 * - Loading workspace-specific MCP servers (.mcp.json)
 * - Merging built-in Nimbalyst MCP servers with user configs
 * - Expanding environment variables in server configurations
 * - Processing server configs for different transport types (stdio, sse)
 *
 * The service is designed to be reusable across different AI providers
 * (ClaudeCodeProvider, CodexProvider, etc.)
 */

import type { ClaudeExecutionResolution } from '../providers/claudeCode/dependencyInjection';

/**
 * Detect Windows-form paths (DOS drive letters or UNC shares). We use this to
 * translate user/workspace stdio MCP args when the actual Claude process runs
 * on the Linux side of WSL — the Windows-side path expansion produces strings
 * like `C:\Users\Bob\.config` that don't exist in the Linux filesystem.
 */
const WINDOWS_PATH_PATTERN = /^[A-Za-z]:[\\/]|^\\\\/;

function looksLikeWindowsPath(value: string): boolean {
  return WINDOWS_PATH_PATTERN.test(value);
}

export interface McpConfigServiceDeps {
  /** Port for the main Nimbalyst MCP server (provides capture_editor_screenshot, etc.) */
  mcpServerPort: number | null;

  /** Port for the session naming MCP server */
  sessionNamingServerPort: number | null;

  /** Port for the extension development MCP server */
  extensionDevServerPort: number | null;

  /** Port for the Super Loop progress MCP server */
  superLoopProgressServerPort: number | null;

  /** Port for the session context MCP server (provides session summary, workstream overview, etc.) */
  sessionContextServerPort: number | null;

  /** Port for the meta-agent MCP server */
  metaAgentServerPort?: number | null;

  /** Loader for user and workspace MCP server configs */
  mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, any>>) | null;

  /** Loader for extension plugins (not used for MCP config, but passed for completeness) */
  extensionPluginsLoader: ((workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>) | null;

  /** Loader for Claude settings environment variables */
  claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null;

  /** Loader for shell environment variables */
  shellEnvironmentLoader: (() => Record<string, string> | null) | null;
}

/**
 * Service for loading and processing MCP server configurations
 */
export class McpConfigService {
  private deps: McpConfigServiceDeps;

  constructor(deps: McpConfigServiceDeps) {
    this.deps = deps;
  }

  /**
   * Get merged MCP server configuration from all sources:
   * 1. Built-in Nimbalyst MCP servers (nimbalyst-mcp, session-naming, extension-dev)
   * 2. User-level MCP servers (~/.config/claude/mcp.json)
   * 3. Workspace-level MCP servers (.mcp.json)
   *
   * Priority order: built-in < user < workspace
   *
   * @param options.sessionId - Session ID for session-specific servers
   * @param options.workspacePath - Workspace path for workspace-specific servers
   * @param options.executionResolution - Execution-environment override for the
   *   current session (currently: WSL on Windows). When set, stdio MCP server
   *   configs are post-processed so paths produced by Windows-side env expansion
   *   are translated into the form Claude (running inside WSL) can resolve.
   *   Servers whose required paths can't be translated are dropped with a
   *   diagnostic to avoid passing bogus paths to the Linux subprocess.
   * @returns Merged MCP server configuration object
   */
  async getMcpServersConfig(
    options: {
      sessionId?: string;
      workspacePath?: string;
      profile?: 'standard' | 'meta-agent';
      executionResolution?: ClaudeExecutionResolution | null;
    }
  ): Promise<Record<string, any>> {
    const { sessionId, workspacePath, profile = 'standard', executionResolution } = options;
    const config: any = {};
    const isMetaAgent = profile === 'meta-agent';

    // Include shared MCP server if it's started (provides capture_editor_screenshot, display_to_user, etc.)
    // applyDiff and streamContent are NOT exposed via MCP - they're only for chat providers via IPC
    if (this.deps.mcpServerPort !== null && workspacePath) {
      let mcpUrl = `http://127.0.0.1:${this.deps.mcpServerPort}/mcp?workspacePath=${encodeURIComponent(workspacePath)}`;
      if (sessionId) {
        mcpUrl += `&sessionId=${encodeURIComponent(sessionId)}`;
      }
      config['nimbalyst-mcp'] = {
        type: 'sse',
        transport: 'sse',
        url: mcpUrl,
        // Override default 60s tool timeout for Codex CLI.
        // Some tools (e.g. developer_git_commit_proposal) block indefinitely
        // waiting for user input — the user may leave and return hours or
        // days later. Use a very large value (~7 days) to effectively disable.
        tool_timeout_sec: 604800,
      };
    }

    // Include session naming MCP server if it's started
    if (this.deps.sessionNamingServerPort !== null && sessionId) {
      config['nimbalyst-session-naming'] = {
        type: 'sse',
        transport: 'sse',
        url: `http://127.0.0.1:${this.deps.sessionNamingServerPort}/mcp?sessionId=${encodeURIComponent(sessionId)}`
      };
    }

    // Include extension dev MCP server if it's started (provides build, install, reload tools)
    if (!isMetaAgent && this.deps.extensionDevServerPort !== null) {
      const params = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : '';
      config['nimbalyst-extension-dev'] = {
        type: 'sse',
        transport: 'sse',
        url: `http://127.0.0.1:${this.deps.extensionDevServerPort}/mcp${params}`
      };
    }

    // Super Loop progress MCP server disabled - was leaking into non-super-loop sessions
    // TODO: Re-enable with proper gating so it only appears in super loop sessions

    // Include session context MCP server if it's started (provides session summary, workstream overview, etc.)
    if (this.deps.sessionContextServerPort !== null && sessionId && workspacePath) {
      config['nimbalyst-session-context'] = {
        type: 'sse',
        transport: 'sse',
        url: `http://127.0.0.1:${this.deps.sessionContextServerPort}/mcp?sessionId=${encodeURIComponent(sessionId)}&workspaceId=${encodeURIComponent(workspacePath)}`
      };
    }

    if ((this.deps.metaAgentServerPort ?? null) !== null && sessionId && workspacePath) {
      config['nimbalyst-meta-agent'] = {
        type: 'sse',
        transport: 'sse',
        url: `http://127.0.0.1:${this.deps.metaAgentServerPort}/mcp?sessionId=${encodeURIComponent(sessionId)}&workspaceId=${encodeURIComponent(workspacePath)}`
      };
    }

    // Meta-agent gets nimbalyst-mcp (for display_to_user, capture_editor_screenshot),
    // user/workspace custom MCPs, but skips extension-dev server (guarded above).

    // Load user and workspace MCP servers using the injected loader (if available)
    // This merges user-level (global) servers with workspace-level servers
    if (this.deps.mcpConfigLoader) {
      try {
        const mergedServers = await this.deps.mcpConfigLoader(workspacePath);

        // Process each server config
        for (const [serverName, serverConfig] of Object.entries(mergedServers)) {
          const processedConfig = await this.processServerConfig(
            serverName,
            serverConfig as any,
            executionResolution ?? null
          );
          if (processedConfig) {
            config[serverName] = processedConfig;
          }
        }
      } catch (error) {
        console.error('[MCP-CONFIG] Failed to load MCP servers from config loader:', error);
        // Fall back to workspace-only loading
        await this.loadWorkspaceMcpServers(workspacePath, config, executionResolution ?? null);
      }
    } else {
      // Fallback: Load from workspace .mcp.json only (legacy behavior)
      await this.loadWorkspaceMcpServers(workspacePath, config, executionResolution ?? null);
    }

    return config;
  }

  /**
   * Process a single MCP server config, expanding env vars and converting to headers where needed
   *
   * For stdio transport:
   * - Expands environment variables in args array
   * - Expands env object values
   *
   * For SSE transport:
   * - Converts API key env vars to Authorization headers
   * - Removes env object (not used for SSE)
   *
   * When `executionResolution` is set (currently: WSL on Windows) and the
   * transport is stdio, after expansion any Windows-form path is translated
   * into the form the Linux Claude subprocess can reach. Servers with at
   * least one untranslatable required path return null so the caller can drop
   * them with a diagnostic — passing them through unchanged would silently
   * produce broken tool execution after the session starts.
   *
   * @param serverName - Name of the MCP server
   * @param serverConfig - Raw server configuration
   * @param executionResolution - Execution-mode resolution (or null)
   * @returns Processed server configuration, or null if the server should be dropped
   */
  private async processServerConfig(
    serverName: string,
    serverConfig: any,
    executionResolution: ClaudeExecutionResolution | null
  ): Promise<any | null> {
    const processedConfig = { ...serverConfig };
    const transportType = processedConfig.type === 'sse' || processedConfig.type === 'http'
      ? processedConfig.type
      : 'stdio';

    // Normalize transport-specific fields so stale config data does not leak
    // into downstream providers. Codex flattens config overrides into
    // repeated `--config a.b.c=value` flags and rejects mixed stdio/remote
    // fields like `command` + `url` on the same server.
    processedConfig.type = transportType;
    if (transportType === 'stdio') {
      delete processedConfig.url;
      delete processedConfig.headers;
    } else {
      delete processedConfig.command;
      delete processedConfig.args;
    }

    // Load environment for variable expansion
    const env = await this.loadEnvironmentForExpansion();

    // Build combined env: loaded env + config.env (config.env takes precedence)
    const combinedEnv: Record<string, string | undefined> = { ...env };
    if (processedConfig.env) {
      for (const [key, value] of Object.entries(processedConfig.env)) {
        combinedEnv[key] = this.expandEnvVar(value as string, combinedEnv);
      }
    }

    // For stdio transport, expand env vars in args
    // This is critical for Windows where shell doesn't expand ${VAR} syntax
    if (transportType === 'stdio' && processedConfig.args && Array.isArray(processedConfig.args)) {
      processedConfig.args = processedConfig.args.map((arg: string) =>
        typeof arg === 'string' ? this.expandEnvVar(arg, combinedEnv) : arg
      );
    }

    // WSL mode: stdio MCP servers are spawned by the Linux Claude subprocess.
    // Anything we already expanded above using Windows-side env (HOME pointing
    // at C:\Users\..., PATH containing C:\Program Files\..., etc.) is now a
    // Windows-form path that doesn't exist in the Linux filesystem. Translate
    // each Windows-form value into its WSL equivalent; drop the server with a
    // diagnostic if any required path can't be translated.
    if (transportType === 'stdio' && executionResolution) {
      if (typeof processedConfig.command === 'string' && looksLikeWindowsPath(processedConfig.command)) {
        const translated = executionResolution.translatePath(processedConfig.command);
        if (!translated) {
          console.warn(
            `[MCP-CONFIG] Dropping MCP server "${serverName}" in ${executionResolution.displayLabel} mode: ` +
            `command "${processedConfig.command}" has no WSL-side equivalent.`
          );
          return null;
        }
        processedConfig.command = translated;
      }

      if (Array.isArray(processedConfig.args)) {
        const translatedArgs: string[] = [];
        for (const arg of processedConfig.args) {
          if (typeof arg === 'string' && looksLikeWindowsPath(arg)) {
            const translated = executionResolution.translatePath(arg);
            if (!translated) {
              console.warn(
                `[MCP-CONFIG] Dropping MCP server "${serverName}" in ${executionResolution.displayLabel} mode: ` +
                `arg "${arg}" has no WSL-side equivalent.`
              );
              return null;
            }
            translatedArgs.push(translated);
          } else {
            translatedArgs.push(arg);
          }
        }
        processedConfig.args = translatedArgs;
      }

      if (processedConfig.env && typeof processedConfig.env === 'object') {
        const translatedEnv: Record<string, string> = {};
        for (const [key, rawValue] of Object.entries(processedConfig.env)) {
          if (typeof rawValue !== 'string') {
            translatedEnv[key] = rawValue as any;
            continue;
          }
          const expanded = this.expandEnvVar(rawValue, combinedEnv);
          if (looksLikeWindowsPath(expanded)) {
            const translated = executionResolution.translatePath(expanded);
            if (!translated) {
              console.warn(
                `[MCP-CONFIG] Dropping MCP server "${serverName}" in ${executionResolution.displayLabel} mode: ` +
                `env var ${key}="${expanded}" has no WSL-side equivalent.`
              );
              return null;
            }
            translatedEnv[key] = translated;
          } else {
            translatedEnv[key] = expanded;
          }
        }
        processedConfig.env = translatedEnv;
      }
    }

    // For SSE transport, convert env vars to headers (SDK requirement)
    if (transportType === 'sse' && processedConfig.env) {
      processedConfig.headers = processedConfig.headers || {};

      // Convert API keys from env to Authorization headers
      for (const [key, value] of Object.entries(processedConfig.env)) {
        if (key.endsWith('_API_KEY')) {
          // Expand environment variable if needed
          const expandedValue = this.expandEnvVar(value as string, env);
          if (expandedValue && !expandedValue.startsWith('${')) {
            processedConfig.headers['Authorization'] = `Bearer ${expandedValue}`;
          }
        }
      }

      // Remove env from SSE config (not used for SSE transport)
      delete processedConfig.env;
    }

    return processedConfig;
  }

  /**
   * Load MCP servers from workspace .mcp.json only (legacy fallback)
   *
   * This method is called when the mcpConfigLoader is not available
   * or when it fails to load configs.
   *
   * @param workspacePath - Path to the workspace
   * @param config - Existing config object to merge into
   * @param executionResolution - Execution-mode resolution (or null) for path translation
   */
  private async loadWorkspaceMcpServers(
    workspacePath: string | undefined,
    config: any,
    executionResolution: ClaudeExecutionResolution | null
  ): Promise<void> {
    if (!workspacePath) return;

    try {
      const fs = require('fs');
      const path = require('path');
      const mcpJsonPath = path.join(workspacePath, '.mcp.json');

      if (fs.existsSync(mcpJsonPath)) {
        const mcpJsonContent = fs.readFileSync(mcpJsonPath, 'utf8');
        const mcpConfig = JSON.parse(mcpJsonContent);

        if (mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object') {
          // Process and merge workspace MCP servers with built-in servers
          for (const [serverName, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
            const processedConfig = await this.processServerConfig(
              serverName,
              serverConfig as any,
              executionResolution
            );
            if (processedConfig) {
              config[serverName] = processedConfig;
            }
          }
        }
      }
    } catch (error) {
      console.error('[MCP-CONFIG] Failed to load .mcp.json:', error);
    }
  }

  /**
   * Expand environment variable syntax: ${VAR} and ${VAR:-default}
   *
   * Supports:
   * - Simple replacement: ${HOME} -> /Users/username
   * - Default values: ${MISSING:-fallback} -> fallback
   *
   * Note: Nested defaults like ${FOO:-${HOME}} are not fully supported.
   * The outer variable will be replaced with the literal default value,
   * which may still contain unexpanded variables.
   *
   * @param value - String potentially containing env var references
   * @param env - Environment variable map
   * @returns String with env vars expanded
   */
  private expandEnvVar(value: string, env: Record<string, string | undefined>): string {
    return value.replace(/\$\{([^}:]+)(:-([^}]+))?\}/g, (_, varName, __, defaultValue) => {
      const envValue = env[varName];
      if (envValue !== undefined) {
        return envValue;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      // Variable not set and no default - return original
      return `\${${varName}}`;
    });
  }

  /**
   * Load environment variables for expansion from all available sources
   *
   * Priority order:
   * 1. process.env (always available)
   * 2. Shell environment (from login shell, includes AWS_*, etc.)
   * 3. Claude settings env (from ~/.claude/settings.json)
   *
   * @returns Merged environment variable map
   */
  private async loadEnvironmentForExpansion(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>)
    };

    // Load shell environment if available
    if (this.deps.shellEnvironmentLoader) {
      try {
        const shellEnv = this.deps.shellEnvironmentLoader();
        if (shellEnv) {
          Object.assign(env, shellEnv);
        }
      } catch (error) {
        console.warn('[MCP-CONFIG] Failed to load shell environment:', error);
      }
    }

    // Load Claude settings env if available
    if (this.deps.claudeSettingsEnvLoader) {
      try {
        const settingsEnv = await this.deps.claudeSettingsEnvLoader();
        if (settingsEnv) {
          Object.assign(env, settingsEnv);
        }
      } catch (error) {
        console.warn('[MCP-CONFIG] Failed to load Claude settings environment:', error);
      }
    }

    return env;
  }
}
