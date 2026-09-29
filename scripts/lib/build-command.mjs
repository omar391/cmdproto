import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeFingerprint,
  readValidRecord,
  writeRecord
} from "./build-cache.mjs";
import { normalizeToken, renderUsage, requireValue } from "./cli-shared.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = dirname(LIB_DIR);

export function runBuild(argv) {
  const options = parseBuildArgs(argv);
  if (options.help) {
    process.stdout.write(`${getBuildUsage()}\n`);
    return;
  }

  const config = buildConfig(options);

  if (config.generate || config.generateOnly) {
    run("buf", [
      "generate",
      "--template",
      config.bufGenTemplate,
      "--config",
      config.bufConfig,
      config.proto
    ], config.cwd);
  }

  if (config.generateOnly) {
    return;
  }

  // Fingerprint once up front: it decides the cache hit, and it is the
  // baseline the post-build re-check compares against. A null fingerprint
  // means the inputs cannot be fingerprinted safely, which disables caching
  // for this run rather than failing the build.
  const preBuild = computeFingerprint(config);
  const cacheable = preBuild !== null;
  if (
    !config.noCache &&
    cacheable &&
    readValidRecord(config.cwd, preBuild.fingerprint, preBuild.key, config)
  ) {
    process.stdout.write("cmdproto build: cache hit, outputs verified\n");
    return;
  }

  run("buf", ["lint", config.proto, "--config", config.bufConfig], config.cwd);
  mkdirSync(dirname(config.schemaOut), { recursive: true });
  mkdirSync(dirname(config.runtimeOut), { recursive: true });
  run("buf", [
    "build",
    "--config",
    config.bufConfig,
    config.proto,
    "--as-file-descriptor-set",
    "-o",
    config.schemaOut
  ], config.cwd);
  run(process.execPath, [
    join(SCRIPTS_DIR, "runtime-manifest.mjs"),
    "--app-name",
    config.appName,
    "--schema",
    config.schemaOut,
    "--out",
    config.runtimeOut
  ], config.cwd);

  if (!cacheable) {
    // Inputs could not be fingerprinted, so there is no record to write and no
    // reason to fail a build that already produced correct outputs.
    return;
  }

  // Re-check inputs after the build. An input that changed mid-build leaves no
  // record, so the next run rebuilds from scratch rather than trusting a
  // descriptor that never matched a stable input set.
  const postBuild = computeFingerprint(config);
  if (postBuild === null || postBuild.key !== preBuild.key) {
    process.stderr.write(
      "cmdproto build: inputs changed during build, not writing cache record\n"
    );
    process.exit(1);
  }
  writeRecord(config.cwd, postBuild.fingerprint, postBuild.key, config);
}

export function getBuildUsage() {
  return renderUsage("cmdproto build [options]", [
    {
      heading: "Options",
      entries: [
        ["--cwd <dir>", "Consumer repository root"],
        ["--app-name <name>", "App name used in rendered machine examples"],
        ["--proto <path>", "Proto input path, default: proto"],
        ["--buf-config <path>", "Buf config path, default: buf.yaml"],
        ["--buf-gen-template <p>", "Buf generate template, default: buf.gen.yaml"],
        ["--out-dir <dir>", "Output directory, default: dist"],
        ["--schema-out <path>", "Descriptor output, default: <out-dir>/schema.binpb"],
        ["--runtime-out <path>", "Runtime manifest output, default: <out-dir>/runtime.binpb"],
        ["--generate", "Run buf generate before schema build"],
        ["--generate-only", "Run buf generate and skip schema build"],
        ["--no-cache", "Force a full build and refresh the build cache record"],
        ["--help", "Show this message"]
      ]
    }
  ]);
}

function parseBuildArgs(argv) {
  const options = {
    appName: "",
    bufConfig: "buf.yaml",
    bufGenTemplate: "buf.gen.yaml",
    cwd: process.cwd(),
    generate: false,
    generateOnly: false,
    help: false,
    noCache: false,
    outDir: "dist",
    proto: "proto",
    runtimeOut: "",
    schemaOut: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--cwd":
        options.cwd = requireValue(argv, ++index, token);
        break;
      case "--app-name":
        options.appName = requireValue(argv, ++index, token);
        break;
      case "--proto":
        options.proto = requireValue(argv, ++index, token);
        break;
      case "--buf-config":
        options.bufConfig = requireValue(argv, ++index, token);
        break;
      case "--buf-gen-template":
        options.bufGenTemplate = requireValue(argv, ++index, token);
        break;
      case "--out-dir":
        options.outDir = requireValue(argv, ++index, token);
        break;
      case "--schema-out":
        options.schemaOut = requireValue(argv, ++index, token);
        break;
      case "--runtime-out":
        options.runtimeOut = requireValue(argv, ++index, token);
        break;
      case "--generate":
        options.generate = true;
        break;
      case "--generate-only":
        options.generateOnly = true;
        break;
      case "--no-cache":
        options.noCache = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function buildConfig(options) {
  const cwd = resolve(options.cwd);
  const outDir = resolvePath(cwd, options.outDir);

  return {
    appName: options.appName || normalizeToken(basename(cwd)),
    bufConfig: options.bufConfig,
    bufConfigPath: resolvePath(cwd, options.bufConfig),
    bufGenTemplate: options.bufGenTemplate,
    cwd,
    generate: options.generate,
    generateOnly: options.generateOnly,
    noCache: options.noCache,
    proto: options.proto,
    runtimeOut: resolvePath(cwd, options.runtimeOut || join(outDir, "runtime.binpb")),
    schemaOut: resolvePath(cwd, options.schemaOut || join(outDir, "schema.binpb"))
  };
}

function resolvePath(cwd, value) {
  return resolve(cwd, value);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
