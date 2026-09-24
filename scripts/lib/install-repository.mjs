/**
 * Repository and configuration resolution for the install commands.
 *
 * Resolution is deterministic: canonicalize the requested directory, walk to
 * the nearest package.json, detect whether that package is cmdproto itself,
 * and otherwise read the declared consumer install configuration. Command
 * line flags always win over configuration, field by field.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { verifyError } from './install-error.mjs';

export const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SOURCE_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_value, index) => 'COM' + (index + 1)),
  ...Array.from({ length: 9 }, (_value, index) => 'LPT' + (index + 1))
]);

/** Validate a command name as a safe cross-platform executable name. */
export function validateCommandName(command) {
  if (typeof command !== 'string' || !COMMAND_PATTERN.test(command)) {
    throw verifyError('INVALID_COMMAND_NAME', 'Command name is not safe on all supported platforms.', {
      command: typeof command === 'string' ? command : null
    });
  }
  if (command === '.' || command === '..' || command.endsWith('.') || command.endsWith(' ')) {
    throw verifyError('INVALID_COMMAND_NAME', 'Command name must not end with a dot or space.', { command });
  }
  const stem = command.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED.has(stem) || WINDOWS_RESERVED.has(command.toUpperCase())) {
    throw verifyError('INVALID_COMMAND_NAME', 'Command name is reserved on Windows.', { command });
  }
  return command;
}

/** Resolve the package manager the launcher should use. */
export function resolvePackageManager(manifest) {
  const declared = manifest.packageManager;
  if (declared === undefined || declared === null || declared === '') return 'npm';
  if (typeof declared !== 'string') {
    throw verifyError('PACKAGE_MANAGER_UNSUPPORTED', 'package.json packageManager must be a string.');
  }
  const identifier = declared.split('@')[0].trim().toLowerCase();
  if (identifier === '') return 'npm';
  if (identifier !== 'npm' && identifier !== 'bun' && identifier !== 'pnpm' && identifier !== 'yarn') {
    throw verifyError(
      'PACKAGE_MANAGER_UNSUPPORTED',
      'Unsupported packageManager "' + identifier + '". Supported: npm, bun, pnpm, yarn.',
      { packageManager: identifier }
    );
  }
  return identifier;
}

/**
 * Resolve the source checkout and the launcher configuration.
 *
 * @param {{cwd?: string, name?: string, runScript?: string, sourceEnv?: string}} options Parsed flags.
 * @param {{cwd: string}} defaults Process defaults.
 */
export function resolveRepository(options, defaults, settings = {}) {
  const requireRunScript = settings.requireRunScript !== false;
  const requested = options.cwd === undefined ? defaults.cwd : options.cwd;
  let start;
  try {
    start = realpathSync(resolve(requested));
  } catch {
    throw verifyError('INVALID_CWD', '--cwd is not an accessible directory: ' + requested);
  }
  if (!isDirectory(start)) {
    throw verifyError('INVALID_CWD', '--cwd is not a directory: ' + requested);
  }

  let current = start;
  let manifestPath;
  for (;;) {
    const candidate = resolve(current, 'package.json');
    if (isFile(candidate)) {
      manifestPath = candidate;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (manifestPath === undefined) {
    throw verifyError('REPOSITORY_NOT_FOUND', 'No package.json was found in this directory or any parent.');
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw verifyError('INVALID_PACKAGE_JSON', 'Could not parse ' + manifestPath + '.');
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw verifyError('INVALID_PACKAGE_JSON', manifestPath + ' must contain a JSON object.');
  }

  const checkout = realpathSync(dirname(manifestPath));
  const configured = readInstallConfiguration(manifest);
  const sourceEnv = resolveSourceEnv(options.sourceEnv !== undefined ? options.sourceEnv : configured.sourceEnv);
  const selfEntry = detectSelfEntry(manifest, checkout);
  if (selfEntry !== null) {
    if (options.runScript !== undefined) {
      throw verifyError(
        'INVALID_USAGE',
        '--run-script is not valid in the cmdproto source checkout; self launchers run bin.cmdproto directly.'
      );
    }
    return { checkout, manifest, manifestPath, selfMode: true, selfEntry, runScript: undefined, packageManager: undefined, sourceEnv };
  }

  const runScript = options.runScript !== undefined ? options.runScript : configured.runScript;
  if (runScript === undefined || runScript === null || runScript === '') {
    if (!requireRunScript) {
      return {
        checkout,
        manifest,
        manifestPath,
        selfMode: false,
        selfEntry: null,
        runScript: undefined,
        packageManager: undefined,
        sourceEnv
      };
    }
    throw verifyError(
      'RUN_SCRIPT_REQUIRED',
      'No run script is available. Pass --run-script or set cmdproto.install.runScript in package.json.'
    );
  }
  if (runScript.length > 128 || /[\u0000-\u001f\u007f]/.test(runScript)) {
    throw verifyError('INVALID_INSTALL_CONFIG', 'cmdproto.install.runScript is not a valid script name.');
  }
  const scripts = manifest.scripts;
  const script = scripts !== null && typeof scripts === 'object' ? scripts[runScript] : undefined;
  if (typeof script !== 'string' || script.trim() === '') {
    if (!requireRunScript) {
      return {
        checkout,
        manifest,
        manifestPath,
        selfMode: false,
        selfEntry: null,
        runScript,
        packageManager: undefined,
        sourceEnv
      };
    }
    throw verifyError(
      'RUN_SCRIPT_NOT_FOUND',
      'package.json has no "' + runScript + '" script. Add it before installing.',
      { runScript }
    );
  }
  return {
    checkout,
    manifest,
    manifestPath,
    selfMode: false,
    selfEntry: null,
    runScript,
    packageManager: resolvePackageManager(manifest),
    sourceEnv
  };
}

function readInstallConfiguration(manifest) {
  const section = manifest.cmdproto;
  if (section === undefined || section === null) return {};
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw verifyError('INVALID_INSTALL_CONFIG', 'package.json cmdproto must be an object.');
  }
  const install = section.install;
  if (install === undefined || install === null) return {};
  if (typeof install !== 'object' || Array.isArray(install)) {
    throw verifyError('INVALID_INSTALL_CONFIG', 'package.json cmdproto.install must be an object.');
  }
  if (install.command !== undefined && typeof install.command !== 'string') {
    throw verifyError('INVALID_INSTALL_CONFIG', 'cmdproto.install.command must be a string.');
  }
  if (install.runScript !== undefined && typeof install.runScript !== 'string') {
    throw verifyError('INVALID_INSTALL_CONFIG', 'cmdproto.install.runScript must be a string.');
  }
  if (install.sourceEnv !== undefined && typeof install.sourceEnv !== 'string') {
    throw verifyError('INVALID_INSTALL_CONFIG', 'cmdproto.install.sourceEnv must be a string.');
  }
  return { command: install.command, runScript: install.runScript, sourceEnv: install.sourceEnv };
}

/** Validate an explicit source-checkout environment variable name. */
export function resolveSourceEnv(sourceEnv) {
  if (sourceEnv === undefined) return undefined;
  if (typeof sourceEnv !== 'string' || !SOURCE_ENV_PATTERN.test(sourceEnv)) {
    throw verifyError(
      'INVALID_INSTALL_CONFIG',
      'Source environment variable names must start with a letter or underscore and contain only letters, digits, and underscores.',
      { sourceEnv: typeof sourceEnv === 'string' ? sourceEnv : null }
    );
  }
  return sourceEnv;
}

/** Resolve the installed command name: flag, then configuration, then default. */
export function resolveCommandName(options, resolved) {
  if (options.name !== undefined) return validateCommandName(options.name);
  const configured = resolved.manifest.cmdproto && typeof resolved.manifest.cmdproto === 'object'
    ? resolved.manifest.cmdproto.install
    : undefined;
  const declared = configured && typeof configured.command === 'string' ? configured.command : undefined;
  if (declared !== undefined) return validateCommandName(declared);
  if (resolved.selfMode) return validateCommandName('cmdproto');
  throw verifyError(
    'INVALID_INSTALL_CONFIG',
    'No command name is available. Pass --name or set cmdproto.install.command in package.json.'
  );
}

function detectSelfEntry(manifest, checkout) {
  if (manifest.name !== 'cmdproto') return null;
  const bin = manifest.bin;
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) return null;
  const entry = bin.cmdproto;
  if (typeof entry !== 'string' || entry.length === 0) return null;
  const absolute = resolve(checkout, entry);
  const relativeEntry = relative(checkout, absolute);
  if (relativeEntry === '' || isAbsolute(relativeEntry) || relativeEntry === '..' || relativeEntry.startsWith('..' + sep)) {
    throw verifyError('SOURCE_ENTRY_NOT_FOUND', 'bin.cmdproto must stay inside the checked-out package.');
  }
  if (!isFile(absolute)) {
    throw verifyError('SOURCE_ENTRY_NOT_FOUND', 'bin.cmdproto is missing: ' + entry + '.');
  }
  return entry.replaceAll('\\', '/');
}

function isFile(pathname) {
  try {
    return statSync(pathname).isFile();
  } catch {
    return false;
  }
}

function isDirectory(pathname) {
  try {
    return statSync(pathname).isDirectory();
  } catch {
    return false;
  }
}
