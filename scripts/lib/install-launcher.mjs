/**
 * Managed launcher rendering and ownership inspection.
 *
 * A launcher is a small Node program with one embedded metadata line. The
 * metadata identifies the owner, the command, the source checkout, and how to
 * start it. Ownership is never inferred from the metadata alone: the complete
 * file must also match a rendered template, so a stray marker inside an
 * unrelated file does not make it safe to replace.
 */

import { lstatSync, readFileSync } from 'node:fs';

export const LAUNCHER_SCHEMA = 'cmdproto.launcher/v1';
export const LAUNCHER_OWNER = 'cmdproto';
export const LAUNCHER_MARKER = 'cmdproto-launcher:';
export const POSIX_METADATA_PREFIX = '// ';
export const WINDOWS_METADATA_PREFIX = 'rem ';

/** Package managers a consumer launcher may use. */
export const PACKAGE_MANAGERS = Object.freeze({
  npm: { executable: 'npm', argumentStyle: 'separator' },
  bun: { executable: 'bun', argumentStyle: 'separator' },
  pnpm: { executable: 'pnpm', argumentStyle: 'separator' },
  yarn: { executable: 'yarn', argumentStyle: 'direct' }
});

/** Signals relayed from a launcher to its running child. */
export const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);

const METADATA_KEYS = Object.freeze([
  'schema',
  'owner',
  'command',
  'kind',
  'sourceCheckout',
  'sourceEnv',
  'entry',
  'runScript',
  'packageManager'
]);

/** Serialize metadata with a fixed key order so bytes are reproducible. */
export function renderMetadata(metadata) {
  const ordered = {};
  for (const key of METADATA_KEYS) {
    ordered[key] = metadata[key];
  }
  return JSON.stringify(ordered);
}

export function metadataLine(metadata, prefix) {
  return prefix + LAUNCHER_MARKER + ' ' + renderMetadata(metadata);
}

/**
 * Emitted launcher program.
 *
 * The generated source uses single quotes and a line scan instead of a regular
 * expression, so it carries no backslashes or embedded double quotes. That
 * keeps the template readable and immune to nested quoting mistakes in the
 * shell hosts that invoke it.
 */
function emittedLauncherBody() {
  return [
    "'use strict';",
    "",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawn } = require('node:child_process');",
    "",
    "const LF = String.fromCharCode(10);",
    "const METADATA_PREFIX = '@@PREFIX@@' + '@@MARKER@@' + ' ';",
    "const FORWARDED_SIGNALS = @@SIGNALS@@;",
    "const PACKAGE_ARGUMENTS = @@PACKAGE_ARGUMENTS@@;",
    "",
    "function readMetadata() {",
    "  const source = fs.readFileSync(__filename, 'utf8');",
    "  for (const line of source.split(LF)) {",
    "    const normalized = line.startsWith('rem ') ? line.slice(4) : line;",
    "    if (normalized.startsWith(METADATA_PREFIX)) {",
    "      return JSON.parse(normalized.slice(METADATA_PREFIX.length));",
    "    }",
    "  }",
    "  throw new Error('launcher metadata is missing');",
    "}",
    "",
    "let metadata;",
    "try {",
    "  metadata = readMetadata();",
    "} catch (error) {",
    "  process.stderr.write('cmdproto: launcher metadata could not be read: ' + error.message + LF);",
    "  process.exit(66);",
    "}",
    "",
    "function fail(exitCode, message) {",
    "  process.stderr.write(metadata.command + ': ' + message + LF);",
    "  process.exit(exitCode);",
    "}",
    "",
    "const hasSourceOverride = Object.prototype.hasOwnProperty.call(process.env, metadata.sourceEnv);",
    "const checkout = hasSourceOverride ? process.env[metadata.sourceEnv] : metadata.sourceCheckout;",
    "const sourceRecovery = hasSourceOverride",
    "  ? 'set ' + metadata.sourceEnv + ' to a valid checkout or unset it'",
    "  : 'reinstall with cmdproto install';",
    "const sourceLabel = hasSourceOverride ? metadata.sourceEnv + ' source override' : 'source checkout';",
    "if (typeof checkout !== 'string' || checkout.length === 0 || !fs.existsSync(checkout)) {",
    "  fail(66, sourceLabel + ' is missing at ' + String(checkout || '') + '; ' + sourceRecovery);",
    "}",
    "let checkoutStats;",
    "try {",
    "  checkoutStats = fs.statSync(checkout);",
    "} catch {",
    "  fail(66, sourceLabel + ' is not readable at ' + checkout + '; ' + sourceRecovery);",
    "}",
    "if (!checkoutStats.isDirectory()) {",
    "  fail(66, sourceLabel + ' is not a directory at ' + checkout + '; ' + sourceRecovery);",
    "}",
    "",
    "const manifestPath = path.join(checkout, 'package.json');",
    "let manifest;",
    "try {",
    "  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
    "} catch {",
    "  fail(66, sourceLabel + ' has no readable package.json at ' + manifestPath + '; ' + sourceRecovery);",
    "}",
    "",
    "let executable;",
    "let launcherArgs;",
    "let childCwd;",
    "let spawnOptions;",
    "if (metadata.kind === 'self') {",
    "  const entryPath = path.join(checkout, metadata.entry);",
    "  if (!fs.existsSync(entryPath)) {",
    "    fail(66, sourceLabel + ' entry is missing at ' + entryPath + '; ' + sourceRecovery);",
    "  }",
    "  executable = process.execPath;",
    "  launcherArgs = [entryPath].concat(process.argv.slice(2));",
    "  childCwd = process.cwd();",
    "  spawnOptions = { stdio: 'inherit', cwd: childCwd };",
    "} else {",
    "  const scripts = manifest && typeof manifest.scripts === 'object' && manifest.scripts ? manifest.scripts : {};",
    "  const script = scripts[metadata.runScript];",
    "  if (typeof script !== 'string' || script.trim() === '') {",
    "    fail(66, sourceLabel + ' no longer defines the ' + metadata.runScript + ' script; ' + sourceRecovery);",
    "  }",
    "  executable = metadata.packageManager;",
    "  launcherArgs = PACKAGE_ARGUMENTS.concat(process.argv.slice(2));",
    "  childCwd = checkout;",
    "  spawnOptions = { stdio: 'inherit', cwd: childCwd };",
    "  if (process.platform === 'win32') {",
    "    const manager = resolveWindowsExecutable(executable);",
    "    if (manager === null) fail(127, executable + ' was not found on PATH; install it and retry');",
    "    const command = '\"' + [manager].concat(launcherArgs).map(quoteWindowsArgument).join(' ') + '\"';",
    "    executable = process.env.ComSpec || 'cmd.exe';",
    "    launcherArgs = ['/d', '/s', '/c', command];",
    "    spawnOptions.windowsVerbatimArguments = true;",
    "  }",
    "}",
    "",
    "function resolveWindowsExecutable(command) {",
    "  const rawPath = typeof process.env.PATH === 'string' ? process.env.PATH : '';",
    "  const rawExtensions = typeof process.env.PATHEXT === 'string' && process.env.PATHEXT.length > 0",
    "    ? process.env.PATHEXT",
    "    : '.COM;.EXE;.BAT;.CMD';",
    "  const candidates = rawExtensions.split(';').filter(Boolean).map((extension) => command + extension.toLowerCase()).concat(command);",
    "  for (const directory of rawPath.split(path.delimiter).filter(Boolean)) {",
    "    for (const candidate of candidates) {",
    "      const absolute = path.join(directory.replace(/^\"(.*)\"$/, '$1'), candidate);",
    "      try {",
    "        if (fs.statSync(absolute).isFile()) return absolute;",
    "      } catch {",
    "        /* continue searching */",
    "      }",
    "    }",
    "  }",
    "  return null;",
    "}",
    "",
    "function quoteWindowsArgument(value) {",
    "  const text = String(value);",
    "  if (text.length === 0) return '\"\"';",
    "  return '\"' + text.replaceAll('%', '%%').replaceAll('^', '^^').replaceAll('!', '^!').replaceAll('\"', '\"\"') + '\"';",
    "}",
    "",
    "const child = spawn(executable, launcherArgs, spawnOptions);",
    "const signalHandlers = new Map();",
    "for (const signal of FORWARDED_SIGNALS) {",
    "  const handler = () => {",
    "    try {",
    "      child.kill(signal);",
    "    } catch {",
    "      /* the child already exited */",
    "    }",
    "  };",
    "  signalHandlers.set(signal, handler);",
    "  process.on(signal, handler);",
    "}",
    "function cleanup() {",
    "  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);",
    "}",
    "",
    "child.on('error', (error) => {",
    "  cleanup();",
    "  if (error && error.code === 'ENOENT') {",
    "    fail(127, executable + ' was not found on PATH; install it and retry');",
    "  }",
    "  fail(1, 'could not start ' + executable + ': ' + (error && error.message ? error.message : String(error)));",
    "});",
    "",
    "child.on('exit', (code, signal) => {",
    "  cleanup();",
    "  if (signal) {",
    "    process.kill(process.pid, signal);",
    "    return;",
    "  }",
    "  process.exit(code === null ? 1 : code);",
    "});",
    ""
  ].join('\n');
}

function substitute(body, token, value) {
  return body.split(token).join(value);
}

export function renderPosixLauncher(metadata) {
  return '#!/usr/bin/env node\n' + metadataLine(metadata, POSIX_METADATA_PREFIX) + '\n' + renderBody(metadata);
}

export function renderCompanionLauncher(metadata) {
  return metadataLine(metadata, POSIX_METADATA_PREFIX) + '\n' + renderBody(metadata);
}

export function renderWindowsCommand(metadata) {
  return [
    '@echo off',
    metadataLine(metadata, WINDOWS_METADATA_PREFIX),
    'node "%~dp0' + metadata.command + '.cmdproto.cjs" %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\n');
}

function renderBody(metadata) {
  const packageArguments = metadata.kind === 'self'
    ? []
    : metadata.packageManager === 'yarn'
      ? ['run', metadata.runScript]
      : ['run', metadata.runScript, '--'];
  let body = emittedLauncherBody();
  body = substitute(body, '@@PREFIX@@', metadata.kind === 'self' ? POSIX_METADATA_PREFIX : POSIX_METADATA_PREFIX);
  body = substitute(body, '@@MARKER@@', LAUNCHER_MARKER);
  body = substitute(body, '@@SIGNALS@@', JSON.stringify(FORWARDED_SIGNALS));
  body = substitute(body, '@@PACKAGE_ARGUMENTS@@', JSON.stringify(packageArguments));
  return body;
}

/** Parse one metadata object from launcher text, or return null. */
export function parseLauncherMetadata(text) {
  const prefix = POSIX_METADATA_PREFIX + LAUNCHER_MARKER + ' ';
  const windowsPrefix = WINDOWS_METADATA_PREFIX + LAUNCHER_MARKER + ' ';
  for (const line of String(text).split('\n')) {
    const candidate = line.startsWith(prefix) ? line.slice(prefix.length) : line.startsWith(windowsPrefix) ? line.slice(windowsPrefix.length) : null;
    if (candidate === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return null;
    }
    return validateMetadata(parsed);
  }
  return null;
}

function validateMetadata(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== METADATA_KEYS.length) return null;
  for (const key of METADATA_KEYS) {
    if (!Object.hasOwn(parsed, key)) return null;
  }
  if (parsed.schema !== LAUNCHER_SCHEMA || parsed.owner !== LAUNCHER_OWNER) return null;
  if (typeof parsed.command !== 'string' || parsed.command.length === 0) return null;
  if (typeof parsed.sourceCheckout !== 'string' || parsed.sourceCheckout.length === 0) return null;
  if (typeof parsed.sourceEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(parsed.sourceEnv)) return null;
  if (parsed.kind === 'self') {
    if (typeof parsed.entry !== 'string' || parsed.entry.length === 0) return null;
    if (parsed.runScript !== null || parsed.packageManager !== null) return null;
    return parsed;
  }
  if (parsed.kind !== 'consumer') return null;
  if (parsed.entry !== null) return null;
  if (typeof parsed.runScript !== 'string' || parsed.runScript.length === 0) return null;
  if (!Object.hasOwn(PACKAGE_MANAGERS, parsed.packageManager)) return null;
  return parsed;
}

/**
 * Inspect one launcher file.
 *
 * @returns {{state: 'absent'|'managed'|'foreign', path: string, metadata: object|null}}
 */
export function inspectLauncherFile(targetPath, role) {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    // Only a genuinely missing path is installable. A dangling symlink, an
    // unreadable entry, or any other error stays an unmanaged file. lstat -- not
    // existsSync, which follows links -- makes that distinction.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'absent', path: targetPath, metadata: null };
    }
    return { state: 'foreign', path: targetPath, metadata: null };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { state: 'foreign', path: targetPath, metadata: null };
  }
  let text;
  try {
    text = readFileSync(targetPath, 'utf8');
  } catch {
    return { state: 'foreign', path: targetPath, metadata: null };
  }
  const metadata = parseLauncherMetadata(text);
  if (metadata === null) return { state: 'foreign', path: targetPath, metadata: null };
  const expected = role === 'windows-primary'
    ? renderWindowsCommand(metadata)
    : role === 'windows-companion'
      ? renderCompanionLauncher(metadata)
      : renderPosixLauncher(metadata);
  if (expected !== text) return { state: 'foreign', path: targetPath, metadata: null };
  return { state: 'managed', path: targetPath, metadata };
}

/**
 * Build the launcher plan for a resolved repository.
 *
 * @returns {{metadata: object, windows: boolean, primaryPath: string,
 *   companionPath: string|null, primaryContents: string, companionContents: string|null}}
 */
export function buildLauncherPlan(command, resolved, binDirectory, platform) {
  const sourceEnv = resolved.sourceEnv === undefined ? deriveSourceEnv(command) : resolved.sourceEnv;
  const metadata = resolved.selfMode
    ? {
        schema: LAUNCHER_SCHEMA,
        owner: LAUNCHER_OWNER,
        command,
        kind: 'self',
        sourceCheckout: resolved.checkout,
        sourceEnv,
        entry: resolved.selfEntry,
        runScript: null,
        packageManager: null
      }
    : {
        schema: LAUNCHER_SCHEMA,
        owner: LAUNCHER_OWNER,
        command,
        kind: 'consumer',
        sourceCheckout: resolved.checkout,
        sourceEnv,
        entry: null,
        runScript: resolved.runScript,
        packageManager: resolved.packageManager
      };
  const windows = platform === 'win32';
  const primaryPath = joinPath(binDirectory, windows ? command + '.cmd' : command);
  const companionPath = windows ? joinPath(binDirectory, command + '.cmdproto.cjs') : null;
  return {
    metadata,
    windows,
    primaryPath,
    companionPath,
    primaryContents: windows ? renderWindowsCommand(metadata) : renderPosixLauncher(metadata),
    companionContents: windows ? renderCompanionLauncher(metadata) : null
  };
}

/** Default source override name for an installed command. */
export function deriveSourceEnv(command) {
  return command.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_SRC';
}

function joinPath(directory, name) {
  const trimmed = directory.endsWith('/') ? directory.slice(0, -1) : directory;
  return trimmed + '/' + name;
}

/** Combined primary/companion state used by install and uninstall decisions. */
export function inspectLauncherTargets(plan) {
  const primary = inspectLauncherFile(plan.primaryPath, plan.windows ? 'windows-primary' : 'posix');
  if (!plan.windows) {
    return { primary, companion: null, state: primary.state };
  }
  const companion = inspectLauncherFile(plan.companionPath, 'windows-companion');
  if (primary.state === 'absent' && companion.state === 'absent') {
    return { primary, companion, state: 'absent' };
  }
  if (primary.state === 'managed' && companion.state === 'managed') {
    const matchingMetadata = renderMetadata(primary.metadata) === renderMetadata(companion.metadata);
    return { primary, companion, state: matchingMetadata ? 'managed' : 'partial' };
  }
  if (primary.state === 'foreign' || companion.state === 'foreign') {
    return { primary, companion, state: 'foreign' };
  }
  return { primary, companion, state: 'partial' };
}
