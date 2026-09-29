import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = dirname(LIB_DIR);
const REPO_DIR = dirname(SCRIPTS_DIR);

export const CACHE_SCHEMA_VERSION = 1;

const CACHE_DIR = join("node_modules", ".cache", "cmdproto");
const CACHE_RECORD_DIR = "build";
const BUNDLED_PLUGIN = join(SCRIPTS_DIR, "buf-plugin-cmdproto");

// Plugins and policies that resolve a version, digest, or other indirection
// outside the checkout cannot be fingerprinted from local bytes, so a hit is
// refused rather than guessed.
const UNFINGERPRINTABLE_PLUGIN_KEYS = new Set([
  "commit",
  "digest",
  "ref",
  "revision",
  "remote"
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeReadFile(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sha256File(path) {
  const bytes = safeReadFile(path);
  return bytes === null ? null : sha256(bytes);
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout;
}

// `buf ls-files --format json` emits JSONL: one object per line, not a JSON
// array. A parse failure or any other surprise disqualifies the cache.
function readLsFiles(cwd, proto, bufConfig) {
  const stdout = capture(
    "buf",
    ["ls-files", proto, "--config", bufConfig, "--include-imports", "--format", "json"],
    cwd
  );

  if (stdout === null) {
    return null;
  }

  const entries = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed?.path !== "string" || !parsed.path) {
      return null;
    }
    entries.push(parsed);
  }

  if (!entries.length) {
    return null;
  }

  // The path list alone is not a fingerprint: an imported proto can change
  // content while this list stays byte-identical. Hash contents, and keep the
  // reported path so a renamed or relocated file still invalidates.
  //
  // A file that cannot be read disables caching entirely. Dropping it would
  // key the cache without one of its inputs, which is exactly the stale-hit
  // failure this cache exists to prevent.
  const fingerprinted = [];
  for (const entry of entries) {
    const digest = sha256File(pathResolve(cwd, entry.path));
    if (digest === null) {
      return null;
    }
    fingerprinted.push({ path: entry.path, importPath: entry.import_path ?? "", digest });
  }

  return fingerprinted.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

// A local plugin affects lint results, so its executable bytes belong in the
// key. A plugin that is not a readable local file cannot be fingerprinted, so
// caching is declined rather than risking a hit that skips changed lint rules.
function collectPluginEntries(plugins, cwd) {
  if (!Array.isArray(plugins)) {
    return null;
  }
  const collected = [];
  for (const entry of plugins) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    for (const key of Object.keys(entry)) {
      if (UNFINGERPRINTABLE_PLUGIN_KEYS.has(key) && entry[key] !== undefined) {
        return null;
      }
    }
    if (typeof entry.plugin !== "string" || !entry.plugin) {
      return null;
    }

    // Only cmdproto's own bundled plugin is fingerprinted directly; the tool
    // digests already cover its launcher, WASM image, and runner.
    const isBundled = pathResolve(cwd, entry.plugin) === BUNDLED_PLUGIN;
    const digest = isBundled ? null : sha256File(pathResolve(cwd, entry.plugin));
    if (!isBundled && digest === null) {
      return null;
    }

    collected.push({ plugin: entry.plugin, path: entry.path ?? "", digest });
  }
  return collected;
}

// Parse the Buf configuration as YAML so unsupported plugin and policy shapes
// are identified from structure rather than guessed from text. A parse error,
// an unexpected shape, or a version we do not recognise declines the cache.
function readBufConfigShape(cwd, bufConfigPath) {
  const raw = safeReadFile(bufConfigPath);
  if (raw === null) {
    return null;
  }

  let config;
  try {
    config = parseYaml(raw.toString("utf8"));
  } catch {
    return null;
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return null;
  }

  // A workspace file, a registry `deps` block, or a non-v2 config all change
  // what buf resolves without changing local bytes we can hash.
  if (config.deps !== undefined || config.policy !== undefined) {
    return null;
  }

  const plugins = collectPluginEntries(config.plugins ?? [], cwd);
  if (plugins === null) {
    return null;
  }

  return {
    config: sha256(raw),
    configPath: pathResolve(cwd, bufConfigPath),
    plugins,
    lock: sha256File(pathResolve(dirname(bufConfigPath), "buf.lock"))
  };
}

function toolDigests() {
  return {
    manifestScript: sha256File(join(SCRIPTS_DIR, "runtime-manifest.mjs")),
    manifestWasm: sha256File(join(REPO_DIR, "dist", "wasm", "cmdproto-runtime-manifest.wasm")),
    pluginLauncher: sha256File(join(SCRIPTS_DIR, "buf-plugin-cmdproto")),
    pluginWasm: sha256File(join(REPO_DIR, "dist", "wasm", "cmdproto-buf-plugin.wasm")),
    // Both the plugin launcher and the manifest script execute through this
    // runner, so a change to it changes lint and manifest behavior.
    wasiRunner: sha256File(join(SCRIPTS_DIR, "run-wasi.mjs"))
  };
}

export function computeFingerprint(config) {
  try {
    const bufVersion = capture("buf", ["--version"], config.cwd);
    if (bufVersion === null) {
      return null;
    }

    const bufConfig = readBufConfigShape(config.cwd, config.bufConfigPath);
    if (bufConfig === null) {
      return null;
    }

    const files = readLsFiles(config.cwd, config.proto, config.bufConfigPath);
    if (files === null || !files.length) {
      return null;
    }

    const fingerprint = {
      schema: CACHE_SCHEMA_VERSION,
      appName: config.appName,
      options: {
        proto: config.proto,
        bufConfig: config.bufConfigPath,
        bufGenTemplate: config.bufGenTemplate,
        schemaOut: config.schemaOut,
        runtimeOut: config.runtimeOut
      },
      bufVersion: bufVersion.trim(),
      bufConfig: bufConfig.config,
      bufLock: bufConfig.lock,
      plugins: bufConfig.plugins,
      files,
      tools: toolDigests()
    };

    return { fingerprint, key: sha256(JSON.stringify(fingerprint)) };
  } catch {
    return null;
  }
}

// One record per fingerprint key, so two build variants in the same checkout
// (for example different app names or output paths) do not evict each other.
export function cacheRecordPath(cwd, key) {
  return join(cwd, CACHE_DIR, CACHE_RECORD_DIR, key + ".json");
}

export function outputDigests(config) {
  return {
    schema: sha256File(config.schemaOut),
    runtime: sha256File(config.runtimeOut)
  };
}

// A record is usable only when it is well-formed, carries the current schema
// version, matches every current input, and both outputs still hash to the
// values recorded at the time of the successful build.
export function readValidRecord(cwd, fingerprint, key, config) {
  const raw = safeReadFile(cacheRecordPath(cwd, key));
  if (raw === null) {
    return false;
  }

  let record;
  try {
    record = JSON.parse(raw.toString("utf8"));
  } catch {
    return false;
  }

  if (
    record?.schema !== CACHE_SCHEMA_VERSION ||
    record?.key !== key ||
    record?.fingerprint?.schema !== CACHE_SCHEMA_VERSION
  ) {
    return false;
  }

  const current = outputDigests(config);
  if (current.schema === null || current.runtime === null) {
    return false;
  }
  if (record.outputs?.schema !== current.schema || record.outputs?.runtime !== current.runtime) {
    return false;
  }

  return true;
}

// Written only after a successful build and a second input check, so an input
// that changed mid-build leaves no record behind.
export function writeRecord(cwd, fingerprint, key, config) {
  const outputs = outputDigests(config);
  if (outputs.schema === null || outputs.runtime === null) {
    return;
  }

  const record = {
    schema: CACHE_SCHEMA_VERSION,
    key,
    fingerprint,
    outputs
  };

  const target = cacheRecordPath(cwd, key);
  const staging = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, target);
  } catch {
    // Cache storage failure is never fatal: the build already succeeded and
    // the next run simply pays full cost again.
    try {
      rmSync(staging, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
  }
}
