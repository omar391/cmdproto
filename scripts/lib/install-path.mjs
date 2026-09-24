/**
 * Per-user PATH persistence for installed launchers.
 *
 * Only the detected shell (or the Windows user Path) is touched. Existing
 * content is preserved, updates are idempotent, and every write is verified by
 * reading the file back. Uninstall deliberately never calls into this module,
 * so the shared PATH entry survives removing one launcher.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { environmentError } from './install-error.mjs';

export const POSIX_BLOCK_BEGIN = '# >>> cmdproto managed PATH >>>';
export const POSIX_BLOCK_END = '# <<< cmdproto managed PATH <<<';
export const POSIX_BLOCK_BODY = 'export PATH="$HOME/.local/bin:$PATH"';
export const FISH_MANAGED_MARKER = '# cmdproto managed PATH';
export const FISH_MANAGED_BODY = 'fish_add_path --prepend --move "$HOME/.local/bin"';
const WINDOWS_MANAGED_ENTRY = '%USERPROFILE%\\.local\\bin';

/** Detect the active shell from SHELL, defaulting to the POSIX profile. */
export function detectShell(env) {
  const shell = typeof env.SHELL === 'string' ? basename(env.SHELL).toLowerCase() : '';
  if (shell === 'zsh') return 'zsh';
  if (shell === 'bash') return 'bash';
  if (shell === 'fish') return 'fish';
  return 'profile';
}

/** The single shell file this run may modify. */
export function shellConfigTarget(shell, env, home) {
  if (shell === 'fish') {
    const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(home, '.config');
    return join(configHome, 'fish', 'conf.d', 'cmdproto-path.fish');
  }
  if (shell === 'zsh') return join(home, '.zshrc');
  if (shell === 'bash') return join(home, '.bashrc');
  return join(home, '.profile');
}

function normalizeDirectory(value, platform) {
  const trimmed = String(value).replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.replaceAll('\\', '/').toLowerCase() : trimmed;
}

/**
 * Expand the documented Windows placeholders and normalize separators so a
 * stored `%USERPROFILE%` entry compares equal to the resolved bin directory.
 */
export function expandWindowsEntry(value, home) {
  return String(value)
    .replace(/^"(.*)"$/, '$1')
    .replace(/%USERPROFILE%/gi, String(home).replaceAll('\\', '/'))
    .replace(/[\\/]+$/, '')
    .replaceAll('\\', '/')
    .toLowerCase();
}

/** Whether the current process PATH already contains the bin directory. */
export function pathContainsDirectory(binDirectory, env, platform) {
  const rawPath = typeof env.PATH === 'string' ? env.PATH : '';
  if (rawPath.length === 0) return false;
  const target = normalizeDirectory(binDirectory, platform);
  return rawPath
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => normalizeDirectory(entry, platform) === target);
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function writeFileAtomically(targetPath, contents, existed) {
  const directory = dirname(targetPath);
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    throw environmentError('PATH_UPDATE_FAILED', 'Could not create ' + directory + '.', { target: targetPath });
  }
  const mode = existed ? statSync(targetPath).mode & 0o777 : 0o644;
  const staging = join(directory, '.' + basename(targetPath) + '.cmdproto-' + process.pid + '-' + Date.now());
  try {
    writeFileSync(staging, contents, { mode });
    renameSync(staging, targetPath);
  } catch {
    try {
      if (existsSync(staging)) unlinkSync(staging);
    } catch {
      /* best-effort cleanup */
    }
    throw environmentError('PATH_UPDATE_FAILED', 'Could not update ' + targetPath + '.', { target: targetPath });
  }
  let readBack;
  try {
    readBack = readFileSync(targetPath, 'utf8');
  } catch {
    throw environmentError('PATH_UPDATE_FAILED', targetPath + ' could not be read back.', { target: targetPath });
  }
  if (readBack !== contents) {
    throw environmentError('PATH_UPDATE_FAILED', targetPath + ' did not persist as written.', { target: targetPath });
  }
}

export function configurePosixShellFile(targetPath) {
  const existed = inspectShellTarget(targetPath);
  const previous = existed ? readFileSync(targetPath, 'utf8') : '';
  const begins = countOccurrences(previous, POSIX_BLOCK_BEGIN);
  const ends = countOccurrences(previous, POSIX_BLOCK_END);
  if (begins !== ends) {
    throw environmentError(
      'SHELL_CONFIG_CONFLICT',
      targetPath + ' has an incomplete cmdproto managed PATH block; repair it before installing.',
      { target: targetPath }
    );
  }
  const canonical = [POSIX_BLOCK_BEGIN, POSIX_BLOCK_BODY, POSIX_BLOCK_END];
  const lines = previous.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (begins === 0) {
    const next = [...lines];
    if (next.length > 0) next.push('');
    next.push(...canonical);
    writeFileAtomically(targetPath, next.join('\n') + '\n', existed);
    return { action: 'added', target: targetPath };
  }

  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === POSIX_BLOCK_BEGIN) {
      let end = index + 1;
      while (end < lines.length && lines[end] !== POSIX_BLOCK_END) end += 1;
      blocks.push({ start: index, end, body: lines.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    index += 1;
  }
  const first = blocks[0];
  const alreadyCanonical = blocks.length === 1
    && first.body.length === 1
    && first.body[0] === POSIX_BLOCK_BODY;
  if (alreadyCanonical) {
    if (!existed || previous !== lines.join('\n') + '\n') {
      writeFileAtomically(targetPath, lines.join('\n') + '\n', existed);
    }
    return { action: 'unchanged', target: targetPath };
  }

  const rebuilt = [];
  let cursor = 0;
  for (const block of blocks) {
    rebuilt.push(...lines.slice(cursor, block.start));
    cursor = block.end + 1;
  }
  rebuilt.push(...lines.slice(cursor));
  while (rebuilt.length > 0 && rebuilt[rebuilt.length - 1] === '') rebuilt.pop();
  const insertAt = Math.min(first.start, rebuilt.length);
  const head = rebuilt.slice(0, insertAt);
  const tail = rebuilt.slice(insertAt);
  const merged = [...head];
  if (merged.length > 0 && merged[merged.length - 1].trim() !== '') merged.push('');
  merged.push(...canonical);
  if (tail.length > 0 && tail[0].trim() !== '') merged.push('');
  merged.push(...tail);
  writeFileAtomically(targetPath, merged.join('\n') + '\n', existed);
  return { action: 'updated', target: targetPath };
}

export function configureFishFile(targetPath) {
  const existed = inspectShellTarget(targetPath);
  const previous = existed ? readFileSync(targetPath, 'utf8') : '';
  const canonical = FISH_MANAGED_MARKER + '\n' + FISH_MANAGED_BODY + '\n';
  if (existed && previous !== canonical) {
    throw environmentError(
      'SHELL_CONFIG_CONFLICT',
      targetPath + ' already exists and is not the canonical cmdproto-managed file.',
      { target: targetPath }
    );
  }
  if (existed && previous === canonical) {
    return { action: 'unchanged', target: targetPath };
  }
  writeFileAtomically(targetPath, canonical, existed);
  return { action: existed ? 'updated' : 'added', target: targetPath };
}

function powerShellLiteral(value) {
  return "'" + String(value).split("'").join("''") + "'";
}

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let result;
  try {
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8'
    });
  } catch (error) {
    return { ok: false, error };
  }
  return { ok: result.status === 0 && !result.error, stdout: (result.stdout || '').trim() };
}

/** Default Windows user-Path adapter backed by the .NET environment API. */
export function defaultWindowsPathAdapter() {
  return {
    read() {
      const result = runPowerShell("[Environment]::GetEnvironmentVariable('Path','User')");
      if (!result.ok) {
        throw environmentError('PATH_UPDATE_FAILED', 'Could not read the Windows user Path.');
      }
      return result.stdout;
    },
    write(value) {
      const script = '[Environment]::SetEnvironmentVariable(' + powerShellLiteral('Path') + ',' + powerShellLiteral(value) + ',' + powerShellLiteral('User') + ')';
      const result = runPowerShell(script);
      if (!result.ok) {
        throw environmentError('PATH_UPDATE_FAILED', 'Could not update the Windows user Path.');
      }
      return true;
    }
  };
}

export function configureWindowsPath(binDirectory, adapter, home) {
  const current = String(adapter.read() || '');
  const entries = current.split(';').filter((entry) => entry.trim().length > 0);
  const target = expandWindowsEntry(binDirectory, home);
  const first = entries[0];
  if (first !== undefined && expandWindowsEntry(first, home) === target) {
    return { action: 'unchanged', target: 'user:Path' };
  }
  const remaining = entries.filter((entry) => expandWindowsEntry(entry, home) !== target);
  const next = [WINDOWS_MANAGED_ENTRY, ...remaining].join(';');
  adapter.write(next);
  const readBack = String(adapter.read() || '').split(';').filter((entry) => entry.trim().length > 0);
  if (readBack.length === 0 || expandWindowsEntry(readBack[0], home) !== target) {
    throw environmentError('PATH_UPDATE_FAILED', 'The Windows user Path did not persist as written.');
  }
  return { action: entries.length === 0 ? 'added' : 'updated', target: 'user:Path' };
}

/**
 * Make the per-user bin directory persistent for the detected shell.
 *
 * @returns {{action: 'added'|'updated'|'unchanged', shell: string, target: string}}
 */
export function ensurePathConfigured(binDirectory, { platform, env, home, windowsPath }) {
  if (platform === 'win32') {
    const adapter = windowsPath === undefined ? defaultWindowsPathAdapter() : windowsPath;
    const result = configureWindowsPath(binDirectory, adapter, home);
    return { ...result, shell: 'windows' };
  }
  const shell = detectShell(env);
  const target = shellConfigTarget(shell, env, home);
  const result = shell === 'fish' ? configureFishFile(target) : configurePosixShellFile(target);
  return { ...result, shell };
}

function inspectShellTarget(pathname) {
  try {
    const stats = lstatSync(pathname);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw environmentError(
        'SHELL_CONFIG_CONFLICT',
        pathname + ' is not a regular file; refusing to replace it.',
        { target: pathname }
      );
    }
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    if (error && error.name === 'InstallError') throw error;
    throw environmentError('PATH_UPDATE_FAILED', 'Could not inspect ' + pathname + '.', { target: pathname });
  }
}
