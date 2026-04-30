/**
 * Pure path translation between Windows and WSL filesystem views.
 *
 * Cases handled:
 *   - DOS paths backed by /mnt/<drive>/...:  C:\Users\x  <->  /mnt/c/Users/x
 *   - UNC entry into WSL home:  \\wsl$\<distro>\home\x  <->  /home/x  (distro-aware)
 *   - The newer alias \\wsl.localhost\<distro>\... is treated like \\wsl$\<distro>\...
 *
 * Anything else (UNC paths to a non-WSL share, paths Claude can't reach from
 * inside WSL like \\printer\share) returns null from windowsToWsl rather than
 * fabricating a mapping. Callers must surface this as a diagnostic, not silently
 * pass a bogus path to Claude.
 *
 * No I/O. Safe to use anywhere.
 */

const DOS_PATH = /^([A-Za-z]):[\\/](.*)$/;
const DRIVE_ONLY = /^([A-Za-z]):[\\/]?$/;
const WSL_UNC = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(?:\\(.*))?$/i;
const MNT_DRIVE = /^\/mnt\/([a-z])(?:\/(.*))?$/;

/**
 * Translate a Windows-form path to its WSL-visible equivalent.
 *
 * Returns null when no equivalent exists in WSL's filesystem view (e.g. a UNC
 * path to a non-WSL host). Callers should treat null as "this workspace can't
 * be used in WSL mode" and surface a diagnostic.
 */
export function windowsToWsl(winPath: string): string | null {
  if (!winPath) return null;

  const wslUncMatch = winPath.match(WSL_UNC);
  if (wslUncMatch) {
    const remainder = wslUncMatch[2] ?? '';
    const linuxPath = '/' + remainder.replace(/\\/g, '/');
    return collapseSlashes(linuxPath);
  }

  const driveOnlyMatch = winPath.match(DRIVE_ONLY);
  if (driveOnlyMatch) {
    return `/mnt/${driveOnlyMatch[1].toLowerCase()}`;
  }

  const dosMatch = winPath.match(DOS_PATH);
  if (dosMatch) {
    const drive = dosMatch[1].toLowerCase();
    const remainder = dosMatch[2].replace(/\\/g, '/');
    return collapseSlashes(`/mnt/${drive}/${remainder}`);
  }

  return null;
}

/**
 * Translate a WSL-form path to its Windows-visible equivalent.
 *
 * `distro` is required for paths inside the Linux root (anything not under
 * /mnt/<drive>); when omitted, those paths return null because we can't form
 * a UNC path without knowing the distro name. /mnt/<drive>/... paths don't
 * need a distro.
 */
export function wslToWindows(linuxPath: string, distro?: string): string | null {
  if (!linuxPath) return null;
  const collapsed = collapseSlashes(linuxPath);

  const mntMatch = collapsed.match(MNT_DRIVE);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const remainder = mntMatch[2] ?? '';
    return remainder ? `${drive}:\\${remainder.replace(/\//g, '\\')}` : `${drive}:\\`;
  }

  if (collapsed.startsWith('/')) {
    if (!distro) return null;
    const remainder = collapsed.slice(1).replace(/\//g, '\\');
    return remainder ? `\\\\wsl$\\${distro}\\${remainder}` : `\\\\wsl$\\${distro}`;
  }

  return null;
}

/**
 * Collapse runs of forward slashes (e.g. "/mnt/c//Users") to single ones,
 * preserving a leading slash. Used internally; exported for tests.
 */
export function collapseSlashes(p: string): string {
  return p.replace(/\/+/g, '/');
}
