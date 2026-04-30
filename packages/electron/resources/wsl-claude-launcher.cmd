@echo off
rem WSL launcher for Claude Code (Nimbalyst).
rem
rem Invoked by the Claude Agent SDK as `pathToClaudeCodeExecutable` whenever a
rem project has opted into WSL execution mode (see wslExecutionResolver.ts).
rem
rem Behavior:
rem   1. wsl.exe --cd "%CD%" auto-translates a Windows-form cwd (the cwd the SDK
rem      passes to child_process.spawn) into the matching /mnt/<drive>/... path
rem      inside WSL, so the Linux-side `claude` runs with the right cwd.
rem   2. WSLENV must be set in the inherited environment (the resolver sets it
rem      explicitly). It controls which Windows-side env vars are forwarded to
rem      the Linux subprocess — the resolver uses an explicit allowlist.
rem   3. All argv tokens passed by the SDK are forwarded verbatim via %*.
rem   4. Claude's stdio JSON protocol relies on raw byte passthrough; cmd.exe and
rem      wsl.exe both pass stdin/stdout through unmodified, but if you suspect
rem      EOL translation issues, set WSLENV to also include WSL_UTF8=1 and pass
rem      `--no-terminal-mode` to the inner claude invocation.
rem
rem KNOWN RISK: Node.js >= 20 refuses to spawn .cmd/.bat files without
rem `shell: true` because of CVE-2024-27980. If the Claude Agent SDK does not
rem pass `shell: true` to its internal child_process.spawn, this launcher will
rem fail with EINVAL/ENOENT and we'll need to ship a precompiled .exe wrapper
rem instead. Surface this through diagnostics in the project AI providers panel.

wsl.exe --cd "%CD%" --exec claude %*
exit /b %ERRORLEVEL%
