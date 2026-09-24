/**
 * The cmdproto install and uninstall commands.
 *
 * These commands add a small source-backed launcher for the current checkout.
 * They are developer tools, not release installers: published npm, Go, and Rust
 * packages keep using their own package managers. Every decision here is made
 * before any file is replaced, and unmanaged data is never overwritten or
 * removed.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { renderUsage } from './cli-shared.mjs';
import { InstallError, environmentError, refusalError, usageError } from './install-error.mjs';
import { buildLauncherPlan, inspectLauncherTargets, PACKAGE_MANAGERS } from './install-launcher.mjs';
import { resolveCommandName, resolveRepository } from './install-repository.mjs';
import { ensurePathConfigured, pathContainsDirectory } from './install-path.mjs';

export const INSTALL_RESULT_SCHEMA = 'cmdproto.install-result/v1';
export const ERROR_SCHEMA = 'cmdproto.error/v1';

export function getInstallUsage() {
  return renderUsage('cmdproto install [options]', [
    {
      heading: 'Options',
      entries: [
        ['--cwd <dir>', 'Directory used to discover the source checkout'],
        ['--name <command>', 'Installed command name, overriding package.json'],
        ['--run-script <script>', 'Package script to run, overriding package.json'],
        ['--source-env <variable>', 'Environment variable that may override the source checkout'],
        ['--force', 'Replace another checkout\'s launcher or shadow a PATH command'],
        ['--help', 'Show this message']
      ]
    },
    {
      heading: 'Notes',
      entries: [
        ['Launcher location', '~/.local/bin (Windows: %USERPROFILE%\\.local\\bin)'],
        ['PATH updates', 'Apply to new shells; the managed block is added once']
      ]
    }
  ]);
}

export function getUninstallUsage() {
  return renderUsage('cmdproto uninstall [options]', [
    {
      heading: 'Options',
      entries: [
        ['--cwd <dir>', 'Directory used to discover the source checkout'],
        ['--name <command>', 'Installed command name, overriding package.json'],
        ['--help', 'Show this message']
      ]
    },
    {
      heading: 'Notes',
      entries: [
        ['Removal scope', 'Removes only launchers owned by this checkout'],
        ['PATH', 'The shared managed PATH entry is deliberately left in place']
      ]
    }
  ]);
}

/** Parse install/uninstall options, rejecting everything undocumented. */
export function parseInstallArgs(argv, command) {
  const options = { cwd: undefined, name: undefined, runScript: undefined, sourceEnv: undefined, force: false, help: false };
  const seen = new Set();
  // A missing value is a usage error, while an explicitly empty value is passed
  // through so the caller reports the precise validation failure.
  const optionValue = (list, index, flag) => {
    const value = list[index];
    if (value === undefined) throw usageError('Missing value for ' + flag);
    return value;
  };
  const setOnce = (key, value, flag) => {
    if (seen.has(key)) throw usageError('Option ' + flag + ' may be given at most once');
    seen.add(key);
    options[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--cwd') {
      setOnce('cwd', optionValue(argv, ++index, token), token);
    } else if (token === '--name') {
      setOnce('name', optionValue(argv, ++index, token), token);
    } else if (token === '--run-script') {
      if (command !== 'install') throw usageError('--run-script is only valid for cmdproto install');
      setOnce('runScript', optionValue(argv, ++index, token), token);
    } else if (token === '--source-env') {
      if (command !== 'install') throw usageError('--source-env is only valid for cmdproto install');
      setOnce('sourceEnv', optionValue(argv, ++index, token), token);
    } else if (token === '--force') {
      if (command !== 'install') throw usageError('--force is only valid for cmdproto install');
      if (options.force) throw usageError('Option --force may be given at most once');
      options.force = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw usageError('Unknown argument: ' + token);
    }
  }
  return options;
}

function buildContext(overrides) {
  return {
    platform: overrides.platform === undefined ? process.platform : overrides.platform,
    env: overrides.env === undefined ? process.env : overrides.env,
    home: overrides.home === undefined ? homedir() : overrides.home,
    cwd: overrides.cwd === undefined ? process.cwd() : overrides.cwd,
    windowsPath: overrides.windowsPath,
    stdout: overrides.stdout === undefined ? process.stdout : overrides.stdout,
    stderr: overrides.stderr === undefined ? process.stderr : overrides.stderr
  };
}

/** Install a source-backed launcher for this checkout. */
export function runInstall(argv, overrides = {}) {
  const context = buildContext(overrides);
  try {
    const options = parseInstallArgs(argv, 'install');
    if (options.help) {
      context.stdout.write(getInstallUsage() + '\n');
      return 0;
    }
    return executeInstall(planInstall(options, context), context);
  } catch (error) {
    return reportFailure(error, context.stderr);
  }
}

/** Remove a launcher owned by this checkout. */
export function runUninstall(argv, overrides = {}) {
  const context = buildContext(overrides);
  try {
    const options = parseInstallArgs(argv, 'uninstall');
    if (options.help) {
      context.stdout.write(getUninstallUsage() + '\n');
      return 0;
    }
    return executeUninstall(planUninstall(options, context), context);
  } catch (error) {
    return reportFailure(error, context.stderr);
  }
}

function planInstall(options, context) {
  const resolved = resolveRepository(options, context);
  const command = resolveCommandName(options, resolved);
  const binDirectory = join(context.home, '.local', 'bin');
  const launcher = buildLauncherPlan(command, resolved, binDirectory, context.platform);
  const targets = inspectLauncherTargets(launcher);
  const collision = findPathCollision(command, binDirectory, launcher, context);
  return { resolved, command, binDirectory, launcher, targets, collision, force: options.force };
}

function planUninstall(options, context) {
  const resolved = resolveRepository({ cwd: options.cwd }, context, { requireRunScript: false });
  const command = resolveCommandName({ name: options.name }, resolved);
  const binDirectory = join(context.home, '.local', 'bin');
  const launcher = buildLauncherPlan(command, resolved, binDirectory, context.platform);
  const targets = inspectLauncherTargets(launcher);
  return { resolved, command, binDirectory, launcher, targets };
}

function executeInstall(plan, context) {
  const { launcher, targets } = plan;
  if (targets.state === 'foreign') {
    throw refusalError(
      'FOREIGN_TARGET',
      launcher.primaryPath + ' exists and is not managed by cmdproto; move it away before installing.',
      { path: launcher.primaryPath }
    );
  }
  if (targets.state === 'partial') {
    throw refusalError(
      'FOREIGN_TARGET',
      launcher.primaryPath + ' has an incomplete cmdproto launcher pair; repair it before installing.',
      { path: launcher.primaryPath }
    );
  }
  const managed = targets.state === 'managed';
  const owner = managed ? targets.primary.metadata.sourceCheckout : null;
  const sameOwner = managed && owner === plan.resolved.checkout;
  if (managed && !sameOwner && !plan.force) {
    throw refusalError(
      'OWNED_BY_OTHER_CHECKOUT',
      launcher.primaryPath + ' belongs to ' + owner + '; reinstall with --force to replace it.',
      { path: launcher.primaryPath, owner }
    );
  }
  if (plan.collision !== null && plan.collision.unshadowable) {
    throw refusalError(
      'PATH_COMMAND_COLLISION',
      plan.collision.path + ' takes precedence over ' + launcher.primaryPath + ' under PATHEXT and cannot be shadowed.',
      { command: plan.command, path: plan.collision.path, launcherPath: launcher.primaryPath }
    );
  }
  if (plan.collision !== null && !plan.force) {
    throw refusalError(
      'PATH_COMMAND_COLLISION',
      plan.collision.path + ' already provides "' + plan.command + '"; reinstall with --force to shadow it.',
      { command: plan.command, path: plan.collision.path }
    );
  }
  if (!plan.resolved.selfMode) {
    const executable = PACKAGE_MANAGERS[plan.resolved.packageManager].executable;
    if (findExecutableOnPath(executable, context) === null) {
      throw environmentError(
        'PACKAGE_MANAGER_NOT_FOUND',
        executable + ' is not available on PATH; install it before adding a launcher.',
        { packageManager: plan.resolved.packageManager }
      );
    }
  }
  ensureBinDirectory(plan.binDirectory);

  const pathResult = ensurePathConfigured(plan.binDirectory, context);
  const newShellRequired = !pathContainsDirectory(plan.binDirectory, context.env, context.platform);

  const unchanged = sameOwner && sameMetadata(targets.primary.metadata, launcher.metadata);
  let status;
  if (unchanged) {
    status = 'unchanged';
  } else if (launcher.windows) {
    const previousCompanion = targets.companion !== null && targets.companion.state === 'managed'
      ? readFileSync(targets.companion.path, 'utf8')
      : null;
    writeLauncherFile(launcher.companionPath, launcher.companionContents, 0o644);
    try {
      writeLauncherFile(launcher.primaryPath, launcher.primaryContents, 0o644);
    } catch (error) {
      try {
        if (previousCompanion !== null) {
          writeLauncherFile(launcher.companionPath, previousCompanion, 0o644);
        } else if (existsSync(launcher.companionPath)) {
          unlinkSync(launcher.companionPath);
        }
      } catch {
        throw environmentError(
          'PARTIAL_INSTALL',
          'The Windows launcher pair is inconsistent; check the bin directory.',
          { paths: [launcher.primaryPath, launcher.companionPath] }
        );
      }
      throw error;
    }
    status = managed ? 'refreshed' : 'installed';
  } else {
    writeLauncherFile(launcher.primaryPath, launcher.primaryContents, 0o755);
    status = managed ? 'refreshed' : 'installed';
  }

  writeResult(context.stdout, {
    schema: INSTALL_RESULT_SCHEMA,
    ok: true,
    action: 'install',
    status,
    command: plan.command,
    launcherPath: launcher.primaryPath,
    companionPath: launcher.companionPath,
    sourceCheckout: plan.resolved.checkout,
    pathAction: {
      action: pathResult.action,
      shell: pathResult.shell,
      target: pathResult.target,
      binDirectory: plan.binDirectory
    },
    newShellRequired
  });
  return 0;
}

function executeUninstall(plan, context) {
  const { launcher, targets } = plan;
  if (targets.state === 'absent') {
    writeResult(context.stdout, uninstallResult(plan, 'absent'));
    return 0;
  }
  if (targets.state === 'foreign') {
    throw refusalError(
      'FOREIGN_TARGET',
      launcher.primaryPath + ' exists and is not a cmdproto-managed launcher; refusing to remove it.',
      { path: launcher.primaryPath }
    );
  }
  if (targets.state === 'partial') {
    throw refusalError(
      'FOREIGN_TARGET',
      launcher.primaryPath + ' has an inconsistent cmdproto launcher pair; repair it before uninstalling.',
      { path: launcher.primaryPath }
    );
  }
  const owner = targets.primary.metadata.sourceCheckout;
  if (owner !== plan.resolved.checkout) {
    throw refusalError(
      'OWNED_BY_OTHER_CHECKOUT',
      launcher.primaryPath + ' belongs to ' + owner + '; uninstall it from that checkout.',
      { path: launcher.primaryPath, owner }
    );
  }
  const paths = launcher.windows ? [launcher.companionPath, launcher.primaryPath] : [launcher.primaryPath];
  for (const pathname of paths) {
    try {
      if (existsSync(pathname)) unlinkSync(pathname);
    } catch {
      throw environmentError(
        'PARTIAL_UNINSTALL',
        'The launcher could not be fully removed; check the bin directory.',
        { paths }
      );
    }
  }
  writeResult(context.stdout, uninstallResult(plan, 'uninstalled'));
  return 0;
}

function uninstallResult(plan, status) {
  return {
    schema: INSTALL_RESULT_SCHEMA,
    ok: true,
    action: 'uninstall',
    status,
    command: plan.command,
    launcherPath: plan.launcher.primaryPath,
    companionPath: plan.launcher.companionPath,
    sourceCheckout: plan.resolved.checkout,
    pathAction: { action: 'retained', shell: null, target: null, binDirectory: plan.binDirectory },
    newShellRequired: false
  };
}

function sameMetadata(left, right) {
  const keys = ['schema', 'owner', 'command', 'kind', 'sourceCheckout', 'sourceEnv', 'entry', 'runScript', 'packageManager'];
  return keys.every((key) => left[key] === right[key]);
}

function ensureBinDirectory(binDirectory) {
  try {
    mkdirSync(binDirectory, { recursive: true, mode: 0o755 });
  } catch {
    throw environmentError('BIN_DIRECTORY_UNWRITABLE', 'Could not create ' + binDirectory + '.', { binDirectory });
  }
  try {
    if (!statSync(binDirectory).isDirectory()) {
      throw environmentError('BIN_DIRECTORY_UNWRITABLE', binDirectory + ' is not a directory.', { binDirectory });
    }
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw environmentError('BIN_DIRECTORY_UNWRITABLE', 'Could not use ' + binDirectory + '.', { binDirectory });
  }
}

function writeLauncherFile(targetPath, contents, mode) {
  const directory = dirname(targetPath);
  const staging = join(directory, '.' + basename(targetPath) + '.cmdproto-' + process.pid + '-' + Date.now());
  try {
    writeFileSync(staging, contents, { mode });
    chmodSync(staging, mode);
    renameSync(staging, targetPath);
  } catch {
    try {
      if (existsSync(staging)) unlinkSync(staging);
    } catch {
      /* best-effort cleanup */
    }
    throw environmentError('LAUNCHER_WRITE_FAILED', 'Could not write ' + targetPath + '.', { path: targetPath });
  }
  let readBack;
  try {
    readBack = readFileSync(targetPath, 'utf8');
  } catch {
    throw environmentError('LAUNCHER_WRITE_FAILED', targetPath + ' could not be read back.', { path: targetPath });
  }
  if (readBack !== contents) {
    throw environmentError('LAUNCHER_WRITE_FAILED', targetPath + ' did not persist as written.', { path: targetPath });
  }
}

function findPathCollision(command, binDirectory, launcher, context) {
  const rawPath = typeof context.env.PATH === 'string' ? context.env.PATH : '';
  const normalizedBin = normalizeDirectory(binDirectory, context.platform);
  let candidates = [{ name: command, precedence: -1 }];
  let launcherPrecedence = 0;
  if (context.platform === 'win32') {
    const extensions = executableExtensions(context.env);
    launcherPrecedence = extensions.findIndex((extension) => extension.toLowerCase() === '.cmd');
    candidates = [
      { name: command, precedence: -1 },
      ...extensions.map((extension, precedence) => ({ name: command + extension.toLowerCase(), precedence }))
    ];
    for (const candidate of candidates) {
      const full = join(binDirectory, candidate.name);
      if (normalizeDirectory(full, context.platform) === normalizeDirectory(launcher.primaryPath, context.platform)) continue;
      if (isExecutableFile(full, context.platform)) {
        return {
          path: full,
          unshadowable: launcherPrecedence === -1 || candidate.precedence < launcherPrecedence
        };
      }
    }
  }
  if (rawPath.length === 0) return null;
  for (const entry of rawPath.split(delimiter).filter((part) => part.length > 0)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (normalizeDirectory(directory, context.platform) === normalizedBin) continue;
    for (const candidate of candidates) {
      const full = join(directory, candidate.name);
      if (isExecutableFile(full, context.platform)) return { path: full, unshadowable: false };
    }
  }
  return null;
}

function findExecutableOnPath(executable, context) {
  const rawPath = typeof context.env.PATH === 'string' ? context.env.PATH : '';
  if (rawPath.length === 0) return null;
  const candidates = context.platform === 'win32'
    ? [executable, ...executableExtensions(context.env).map((extension) => executable + extension.toLowerCase())]
    : [executable];
  for (const entry of rawPath.split(delimiter).filter((part) => part.length > 0)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    for (const candidate of candidates) {
      const full = join(directory, candidate);
      if (isExecutableFile(full, context.platform)) return full;
    }
  }
  return null;
}

function executableExtensions(env) {
  const raw = typeof env.PATHEXT === 'string' && env.PATHEXT.length > 0 ? env.PATHEXT : '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function normalizeDirectory(value, platform) {
  const trimmed = String(value).replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.replaceAll('\\', '/').toLowerCase() : trimmed;
}

function isExecutableFile(candidate, platform) {
  try {
    const stats = statSync(candidate);
    if (!stats.isFile()) return false;
    if (platform === 'win32') return true;
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function writeResult(stream, result) {
  stream.write(JSON.stringify(result) + '\n');
}

function reportFailure(error, stderr) {
  if (error instanceof InstallError) {
    stderr.write(
      JSON.stringify({
        schema: ERROR_SCHEMA,
        ok: false,
        error: { code: error.code, message: error.message, details: error.details }
      }) + '\n'
    );
    return error.exitCode;
  }
  stderr.write(
    JSON.stringify({
      schema: ERROR_SCHEMA,
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
        details: {}
      }
    }) + '\n'
  );
  return 1;
}
