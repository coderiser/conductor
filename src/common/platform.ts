/**
 * Platform utilities for resolving safe local directories.
 * Shared between the Electron main process and the daemon.
 */

/**
 * Resolve a guaranteed-local directory path on Windows.
 *
 * UNC paths (\\server\share) cannot be used as a process cwd — cmd.exe refuses
 * with "CMD 不支持将 UNC 路径作为当前目录". This helper walks a fallback chain
 * of well-known environment variables and validates that none of them resolve
 * to a UNC path before returning.
 *
 * Fallback order:
 *   1. USERPROFILE          (e.g. C:\Users\Alice)
 *   2. HOMEDRIVE + '\'      (e.g. C:\)
 *   3. SystemRoot            (e.g. C:\Windows)
 *   4. fallback              (caller-supplied, defaults to 'C:\')
 *
 * On non-Windows platforms, returns undefined (callers should use their own cwd).
 */
export function resolveSafeLocalDir(fallback = 'C:\\'): string {
  if (process.platform !== 'win32') return fallback;

  const candidates = [
    process.env.USERPROFILE,
    process.env.HOMEDRIVE ? process.env.HOMEDRIVE + '\\' : undefined,
    process.env.SystemRoot,
    fallback,
  ];

  for (const dir of candidates) {
    if (dir && !dir.startsWith('\\\\')) {
      return dir;
    }
  }

  // Ultimate fallback — should never be reached on a real Windows system
  return 'C:\\';
}
