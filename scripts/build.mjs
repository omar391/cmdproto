#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
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
    join(SCRIPT_DIR, "runtime-manifest.mjs"),
    "--app-name",
    config.appName,
    "--schema",
    config.schemaOut,
    "--out",
    config.runtimeOut
  ], config.cwd);
}

function parseArgs(argv) {
  const options = {
    appName: "",
    bufConfig: "buf.yaml",
    bufGenTemplate: "buf.gen.yaml",
    cwd: process.cwd(),
    generate: false,
    generateOnly: false,
    help: false,
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
    bufGenTemplate: options.bufGenTemplate,
    cwd,
    generate: options.generate,
    generateOnly: options.generateOnly,
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

function normalizeToken(value) {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "app";
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function usage() {
  return [
    "Usage: cmdproto-build [options]",
    "",
    "Options:",
    "  --cwd <dir>              Consumer repository root",
    "  --app-name <name>        App name used in rendered machine examples",
    "  --proto <path>           Proto input path, default: proto",
    "  --buf-config <path>      Buf config path, default: buf.yaml",
    "  --buf-gen-template <p>   Buf generate template, default: buf.gen.yaml",
    "  --out-dir <dir>          Output directory, default: dist",
    "  --schema-out <path>      Descriptor output, default: <out-dir>/schema.binpb",
    "  --runtime-out <path>     Runtime manifest output, default: <out-dir>/runtime.binpb",
    "  --generate               Run buf generate before schema build",
    "  --generate-only          Run buf generate and skip schema build",
    "  --help                   Show this message"
  ].join("\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
