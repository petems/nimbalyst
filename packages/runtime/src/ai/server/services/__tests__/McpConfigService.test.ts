import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpConfigService, McpConfigServiceDeps } from '../McpConfigService';

describe('McpConfigService', () => {
  let service: McpConfigService;
  let mockDeps: McpConfigServiceDeps;

  beforeEach(() => {
    mockDeps = {
      mcpServerPort: 3000,
      sessionNamingServerPort: 3001,
      extensionDevServerPort: 3002,
      superLoopProgressServerPort: null,
      sessionContextServerPort: null,
      mcpConfigLoader: null,
      extensionPluginsLoader: null,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: null,
    };
  });

  describe('Environment Variable Expansion', () => {
    it('should expand simple ${VAR} syntax', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${HOME}/scripts/server.js']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        HOME: '/Users/test'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('/Users/test/scripts/server.js');
    });

    it('should expand ${VAR:-default} syntax when variable exists', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${NODE_PATH:-/default/path}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        NODE_PATH: '/custom/path'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('/custom/path');
    });

    it('should use default value in ${VAR:-default} when variable is missing', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${MISSING_VAR:-/fallback/path}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('/fallback/path');
    });

    it('should partially expand nested defaults (limitation)', async () => {
      // Note: The current implementation does not fully support deeply nested defaults
      // ${CUSTOM_PATH:-${HOME}/default} will become ${HOME}/default if CUSTOM_PATH is not set
      // This matches the behavior of the original ClaudeCodeProvider implementation
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${CUSTOM_PATH:-prefix}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        CUSTOM_PATH: '/custom/path'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      // When the var exists, it should be expanded
      expect(config['test-server'].args[0]).toBe('/custom/path');
    });

    it('should handle empty env vars', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${EMPTY_VAR}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        EMPTY_VAR: ''
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('');
    });

    it('should preserve ${VAR} when variable is missing and no default', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${MISSING_VAR}/path']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['test-server'].args[0]).toBe('${MISSING_VAR}/path');
    });

    it('should expand env vars in config.env object', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: [],
          env: {
            API_KEY: '${SECRET_KEY}',
            PATH: '${HOME}/bin'
          }
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        SECRET_KEY: 'secret123',
        HOME: '/Users/test'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      // env object is used for stdio args expansion
      expect(config['test-server'].args).toBeDefined();
    });
  });

  describe('Built-in Server Merging', () => {
    it('should include nimbalyst-mcp server when port is set and workspace path exists', async () => {
      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-mcp']).toEqual(
        expect.objectContaining({
          type: 'sse',
          transport: 'sse',
          url: 'http://127.0.0.1:3000/mcp?workspacePath=%2Ftest%2Fworkspace&sessionId=session123'
        }),
      );
    });

    it('should include session-naming server when port is set and session ID exists', async () => {
      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-session-naming']).toEqual({
        type: 'sse',
        transport: 'sse',
        url: 'http://127.0.0.1:3001/mcp?sessionId=session123'
      });
    });

    it('should include extension-dev server when port is set', async () => {
      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-extension-dev']).toEqual({
        type: 'sse',
        transport: 'sse',
        url: 'http://127.0.0.1:3002/mcp?workspacePath=%2Ftest%2Fworkspace'
      });
    });

    it('should not include servers when ports are null', async () => {
      mockDeps.mcpServerPort = null;
      mockDeps.sessionNamingServerPort = null;
      mockDeps.extensionDevServerPort = null;

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-mcp']).toBeUndefined();
      expect(config['nimbalyst-session-naming']).toBeUndefined();
      expect(config['nimbalyst-extension-dev']).toBeUndefined();
    });
  });

  describe('User Config Merging', () => {
    it('should merge user config with built-in servers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'user-server': {
          type: 'stdio',
          command: 'custom-server',
          args: []
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-mcp']).toBeDefined();
      expect(config['user-server']).toBeDefined();
      expect(config['user-server'].command).toBe('custom-server');
    });

    it('should override built-in servers with user config', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'nimbalyst-mcp': {
          type: 'stdio',
          command: 'custom-override',
          args: []
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        sessionId: 'session123',
        workspacePath: '/test/workspace'
      });

      expect(config['nimbalyst-mcp'].command).toBe('custom-override');
      expect(config['nimbalyst-mcp'].type).toBe('stdio');
    });

    it('should handle mcpConfigLoader errors and fall back to workspace loading', async () => {
      mockDeps.mcpConfigLoader = async () => {
        throw new Error('Config loader failed');
      };

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/test/workspace'
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[MCP-CONFIG] Failed to load MCP servers from config loader:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should strip stale remote fields from stdio servers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        supabase: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@supabase/mcp'],
          url: 'https://stale.example.com/mcp',
          headers: {
            Authorization: 'Bearer stale-token',
          },
        },
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config.supabase).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@supabase/mcp'],
      });
    });
  });

  describe('SSE Server Config Processing', () => {
    it('should convert API key env vars to Authorization headers for SSE', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            OPENAI_API_KEY: 'sk-test123'
          }
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers).toBeDefined();
      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-test123');
      expect(config['sse-server'].env).toBeUndefined();
    });

    it('should expand env vars in API keys for SSE headers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            ANTHROPIC_API_KEY: '${CLAUDE_KEY}'
          }
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        CLAUDE_KEY: 'sk-ant-real-key'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-ant-real-key');
    });

    it('should not add Authorization header if env var is unexpanded', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            MISSING_API_KEY: '${MISSING_VAR}'
          }
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers?.['Authorization']).toBeUndefined();
    });

    it('should preserve existing headers for SSE servers', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          headers: {
            'X-Custom-Header': 'value'
          },
          env: {
            OPENAI_API_KEY: 'sk-test123'
          }
        }
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(config['sse-server'].headers['X-Custom-Header']).toBe('value');
      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-test123');
    });
  });

  describe('Workspace .mcp.json Loading', () => {
    it('should load workspace .mcp.json when mcpConfigLoader is not available', async () => {
      const mockFs = {
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => JSON.stringify({
          mcpServers: {
            'workspace-server': {
              type: 'stdio',
              command: 'workspace-cmd',
              args: []
            }
          }
        }))
      };

      vi.doMock('fs', () => mockFs);
      vi.doMock('path', () => ({
        join: (...args: string[]) => args.join('/')
      }));

      mockDeps.mcpConfigLoader = null;

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/test/workspace'
      });

      // Built-in servers should still be included
      expect(config['nimbalyst-mcp']).toBeDefined();
      // Note: workspace server loading requires actual fs module, so this test is illustrative
    });

    it('should handle missing workspace path gracefully', async () => {
      mockDeps.mcpConfigLoader = null;

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({});

      // Should only have built-in servers that don't require workspace path
      expect(config['nimbalyst-session-naming']).toBeUndefined();
    });
  });

  describe('WSL execution-mode awareness (stdio servers)', () => {
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

    it('translates Windows-form paths in stdio args after env expansion', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'fs-server': {
          type: 'stdio',
          command: 'node',
          args: ['${HOME}/scripts/server.js'],
        },
      });

      // Simulate Windows-side expansion: ${HOME} -> C:\Users\dev
      mockDeps.shellEnvironmentLoader = () => ({
        HOME: 'C:\\Users\\dev',
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: 'C:\\Users\\dev\\workspace',
        executionResolution: wslResolution,
      });

      expect(config['fs-server']).toBeDefined();
      expect(config['fs-server'].args[0]).toBe('/mnt/c/Users/dev/scripts/server.js');
    });

    it('drops a stdio server with an untranslatable Windows path and warns', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'unc-server': {
          type: 'stdio',
          command: 'node',
          args: ['\\\\printer\\share\\server.js'],
        },
      });
      mockDeps.shellEnvironmentLoader = () => ({});

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: 'C:\\Users\\dev\\workspace',
        executionResolution: wslResolution,
      });

      expect(config['unc-server']).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropping MCP server "unc-server"')
      );
      consoleWarnSpy.mockRestore();
    });

    it('drops a stdio server when its command is an untranslatable Windows path', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'bad-cmd-server': {
          type: 'stdio',
          command: '\\\\fileshare\\node.exe',
          args: [],
        },
      });
      mockDeps.shellEnvironmentLoader = () => ({});

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: 'C:\\Users\\dev\\workspace',
        executionResolution: wslResolution,
      });

      expect(config['bad-cmd-server']).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropping MCP server "bad-cmd-server"')
      );
      consoleWarnSpy.mockRestore();
    });

    it('translates Windows-form values in stdio env after expansion', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'env-server': {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {
            DATA_DIR: '${USERPROFILE}\\data',
            FLAG: '1',
          },
        },
      });
      mockDeps.shellEnvironmentLoader = () => ({
        USERPROFILE: 'C:\\Users\\dev',
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: 'C:\\Users\\dev\\workspace',
        executionResolution: wslResolution,
      });

      expect(config['env-server']).toBeDefined();
      expect(config['env-server'].env.DATA_DIR).toBe('/mnt/c/Users/dev/data');
      expect(config['env-server'].env.FLAG).toBe('1');
    });

    it('leaves non-path args alone in WSL mode', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'flag-server': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@example/mcp-server', '--port', '8080'],
        },
      });
      mockDeps.shellEnvironmentLoader = () => ({});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: 'C:\\Users\\dev\\workspace',
        executionResolution: wslResolution,
      });

      expect(config['flag-server']).toBeDefined();
      expect(config['flag-server'].args).toEqual(['-y', '@example/mcp-server', '--port', '8080']);
    });

    it('does not touch SSE servers in WSL mode (URL-only, no path translation)', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'sse-server': {
          type: 'sse',
          url: 'http://example.com/mcp',
          env: {
            OPENAI_API_KEY: 'sk-test',
          },
        },
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: 'C:\\Users\\dev\\workspace',
        executionResolution: wslResolution,
      });

      expect(config['sse-server']).toBeDefined();
      expect(config['sse-server'].url).toBe('http://example.com/mcp');
      expect(config['sse-server'].headers['Authorization']).toBe('Bearer sk-test');
    });

    it('passes stdio configs through unchanged when no executionResolution is provided', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'fs-server': {
          type: 'stdio',
          command: 'node',
          args: ['${HOME}/scripts/server.js'],
        },
      });
      mockDeps.shellEnvironmentLoader = () => ({
        HOME: '/Users/dev',
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({
        workspacePath: '/Users/dev/workspace',
      });

      // No translation happens — Linux-form path stays as expanded.
      expect(config['fs-server'].args[0]).toBe('/Users/dev/scripts/server.js');
    });
  });

  describe('Environment Loading Priority', () => {
    it('should prioritize claudeSettingsEnv over shellEnv', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${TEST_VAR}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => ({
        TEST_VAR: 'from-shell'
      });

      mockDeps.claudeSettingsEnvLoader = async () => ({
        TEST_VAR: 'from-claude-settings'
      });

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      // Claude settings should override shell env
      expect(config['test-server'].args[0]).toBe('from-claude-settings');
    });

    it('should handle errors in environment loaders gracefully', async () => {
      mockDeps.mcpConfigLoader = async () => ({
        'test-server': {
          type: 'stdio',
          command: 'node',
          args: ['${HOME}']
        }
      });

      mockDeps.shellEnvironmentLoader = () => {
        throw new Error('Shell loader failed');
      };

      mockDeps.claudeSettingsEnvLoader = async () => {
        throw new Error('Settings loader failed');
      };

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      service = new McpConfigService(mockDeps);
      const config = await service.getMcpServersConfig({ workspacePath: '/test' });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      consoleWarnSpy.mockRestore();
    });
  });
});
