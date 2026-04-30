import { describe, it, expect } from 'vitest';
import { windowsToWsl, wslToWindows, collapseSlashes } from '../pathTranslation';

describe('windowsToWsl', () => {
  it('translates a basic DOS path', () => {
    expect(windowsToWsl('C:\\Users\\x\\repo')).toBe('/mnt/c/Users/x/repo');
  });

  it('lowercases the drive letter regardless of input case', () => {
    expect(windowsToWsl('C:\\foo')).toBe('/mnt/c/foo');
    expect(windowsToWsl('c:\\foo')).toBe('/mnt/c/foo');
    expect(windowsToWsl('D:\\foo')).toBe('/mnt/d/foo');
  });

  it('handles drive-only paths', () => {
    expect(windowsToWsl('C:\\')).toBe('/mnt/c');
    expect(windowsToWsl('C:/')).toBe('/mnt/c');
  });

  it('preserves spaces and unicode in path segments', () => {
    expect(windowsToWsl('C:\\Users\\Peter Souter\\My Projects'))
      .toBe('/mnt/c/Users/Peter Souter/My Projects');
    expect(windowsToWsl('C:\\Users\\zoë\\café'))
      .toBe('/mnt/c/Users/zoë/café');
  });

  it('accepts forward-slash-form DOS paths', () => {
    expect(windowsToWsl('C:/Users/x/repo')).toBe('/mnt/c/Users/x/repo');
  });

  it('collapses doubled separators', () => {
    expect(windowsToWsl('C:\\\\Users\\\\x')).toBe('/mnt/c/Users/x');
  });

  it('translates \\\\wsl$\\<distro>\\... UNC into the Linux root', () => {
    expect(windowsToWsl('\\\\wsl$\\Ubuntu\\home\\peter\\repo'))
      .toBe('/home/peter/repo');
  });

  it('handles the wsl.localhost alias', () => {
    expect(windowsToWsl('\\\\wsl.localhost\\Ubuntu\\home\\peter'))
      .toBe('/home/peter');
  });

  it('UNC root with no remainder returns "/"', () => {
    expect(windowsToWsl('\\\\wsl$\\Ubuntu')).toBe('/');
  });

  it('returns null for non-WSL UNC and unknown shapes', () => {
    expect(windowsToWsl('\\\\fileserver\\share\\foo')).toBeNull();
    expect(windowsToWsl('not-a-path')).toBeNull();
    expect(windowsToWsl('')).toBeNull();
  });
});

describe('wslToWindows', () => {
  it('translates /mnt/<drive>/... back to a DOS path', () => {
    expect(wslToWindows('/mnt/c/Users/x/repo')).toBe('C:\\Users\\x\\repo');
  });

  it('uppercases the drive letter', () => {
    expect(wslToWindows('/mnt/d/foo')).toBe('D:\\foo');
  });

  it('handles drive root with no remainder', () => {
    expect(wslToWindows('/mnt/c')).toBe('C:\\');
    expect(wslToWindows('/mnt/c/')).toBe('C:\\');
  });

  it('translates Linux paths to UNC when distro is provided', () => {
    expect(wslToWindows('/home/peter/repo', 'Ubuntu'))
      .toBe('\\\\wsl$\\Ubuntu\\home\\peter\\repo');
  });

  it('returns null for Linux paths without a distro', () => {
    expect(wslToWindows('/home/peter/repo')).toBeNull();
  });

  it('handles "/" with a distro', () => {
    expect(wslToWindows('/', 'Ubuntu')).toBe('\\\\wsl$\\Ubuntu');
  });

  it('round-trips DOS paths with spaces', () => {
    const wsl = windowsToWsl('C:\\Users\\Peter Souter\\repo');
    expect(wsl).toBeTruthy();
    expect(wslToWindows(wsl as string)).toBe('C:\\Users\\Peter Souter\\repo');
  });

  it('returns null for inputs that aren\'t Linux-absolute', () => {
    expect(wslToWindows('relative/path')).toBeNull();
    expect(wslToWindows('')).toBeNull();
  });
});

describe('collapseSlashes', () => {
  it('collapses runs of slashes', () => {
    expect(collapseSlashes('/mnt//c///Users')).toBe('/mnt/c/Users');
  });
});
