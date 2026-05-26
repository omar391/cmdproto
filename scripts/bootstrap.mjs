#!/usr/bin/env node

import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || !command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command !== "init") {
    throw new Error(`Unknown command: ${command}`);
  }

  const config = buildConfig(options);
  const writes = [];

  writes.push(writePackageJson(config));
  writes.push(writeTextFile(config.bufGenPath, renderBufGenConfig(), config.force));
  writes.push(writeTextFile(config.bufConfigPath, renderBufConfig(), config.force));
  writes.push(writeTextFile(config.protoPath, renderProtoTemplate(config), config.force));

  if (config.runtime === "ts") {
    writes.push(writeTextFile(config.runtimePath, renderRuntimeTemplate(config), config.force));
    if (!existsSync(config.tsconfigPath)) {
      writes.push(writeTextFile(config.tsconfigPath, renderTsconfig(), false));
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        appName: config.appName,
        target: config.cwd,
        files: writes
      },
      null,
      2
    )}\n`
  );
}

function parseArgs(argv) {
  const options = {
    appName: "",
    command: "",
    bufConfigName: "buf.yaml",
    cwd: process.cwd(),
    force: false,
    help: false,
    method: "Run",
    protoPackage: "",
    runtime: "auto",
    service: "",
    summary: ""
  };

  const command = argv[0] ?? "";

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--cwd":
        options.cwd = requireValue(argv, ++index, token);
        break;
      case "--buf-config-name":
        options.bufConfigName = requireValue(argv, ++index, token);
        break;
      case "--app-name":
        options.appName = requireValue(argv, ++index, token);
        break;
      case "--proto-package":
        options.protoPackage = requireValue(argv, ++index, token);
        break;
      case "--service":
        options.service = requireValue(argv, ++index, token);
        break;
      case "--method":
        options.method = requireValue(argv, ++index, token);
        break;
      case "--command":
        options.command = requireValue(argv, ++index, token);
        break;
      case "--summary":
        options.summary = requireValue(argv, ++index, token);
        break;
      case "--runtime":
        options.runtime = requireValue(argv, ++index, token);
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return { command, options };
}

function buildConfig(options) {
  const cwd = resolve(options.cwd);
  const appName = options.appName || basename(cwd);
  const appToken = normalizeToken(appName);
  const protoPackage = options.protoPackage || `${appToken}.v1`;
  const packagePath = protoPackage.replaceAll(".", "/");
  const service = options.service || `${toPascalCase(appName)}Service`;
  const method = options.method || "Run";
  const commandPath = options.command || toKebabCase(method);
  const summary = options.summary || `Execute ${appName}.`;
  const packageJsonPath = join(cwd, "package.json");
  const tsconfigPath = join(cwd, "tsconfig.json");
  const packageJson = existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, "utf8"))
    : null;
  const runtime = resolveRuntime(options.runtime, packageJson, tsconfigPath);

  return {
    appName,
    appToken,
    bufConfigName: options.bufConfigName,
    bufConfigPath: join(cwd, options.bufConfigName),
    bufGenPath: join(cwd, "buf.gen.yaml"),
    commandPath,
    cwd,
    force: options.force,
    method,
    packageJson,
    packagePath,
    protoPackage,
    protoPath: join(cwd, "proto", packagePath, `${appToken}.proto`),
    runtime,
    runtimePath: join(cwd, "src/cmdproto/app.mts"),
    service,
    summary,
    tsconfigPath
  };
}

function writePackageJson(config) {
  const path = join(config.cwd, "package.json");
  const existed = existsSync(path);
  const pkg = config.packageJson
    ? structuredClone(config.packageJson)
    : {
        name: config.appToken,
        private: true,
        type: "module"
      };

  pkg.type ??= "module";
  pkg.scripts ??= {};
  pkg.devDependencies ??= {};

  pkg.scripts["cmdproto:schema"] =
    "cmdproto-build --app-name " + config.appToken + " --buf-config " + config.bufConfigName;
  pkg.scripts["cmdproto:gen"] =
    "cmdproto-build --generate-only --buf-config " + config.bufConfigName;

  if (config.runtime === "ts") {
    pkg.scripts["cmdproto:run"] = "npm run cmdproto:schema --silent && tsx src/cmdproto/app.mts";
    pkg.devDependencies["@types/node"] ??= "^24.10.0";
    pkg.devDependencies["tsx"] ??= "^4.20.6";
    pkg.devDependencies["typescript"] ??= "^5.9.3";
  }

  ensureParentDirectory(path);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { action: existed ? "updated" : "created", path };
}

function writeTextFile(path, contents, force) {
  const existed = existsSync(path);
  if (existed && !force) {
    return { action: "kept", path };
  }
  ensureParentDirectory(path);
  writeFileSync(path, contents, "utf8");
  return { action: existed ? "updated" : "created", path };
}

function ensureParentDirectory(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function renderBufConfig() {
  return `version: v2
modules:
  - path: proto
  - path: node_modules/cmdproto/proto
lint:
  use:
    - STANDARD
    - CMDPROTO
plugins:
  - plugin: ./node_modules/.bin/cmdproto-buf-plugin
breaking:
  use:
    - FILE
`;
}

function renderBufGenConfig() {
  return `version: v2
plugins: []
`;
}

function renderProtoTemplate(config) {
  return `edition = "2024";

package ${config.protoPackage};

import "cmdproto/v1/options.proto";

service ${config.service} {
  rpc ${config.method}(${config.method}Request) returns (${config.method}Response) {
    option (cmdproto.v1.command) = {
      path: "${config.commandPath}"
      summary: "${escapeProto(config.summary)}"
      example: {
        command: "${config.commandPath} demo -v"
        description: "Exercise the generated ${config.commandPath} command."
        request_json: "{\\"input\\":\\"demo\\",\\"verbose\\":true}"
      }
    };
  }
}

message ${config.method}Request {
  string input = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
      help: "Primary command input."
    }
  ];

  bool verbose = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "verbose"
        short: "v"
      }
      help: "Emit a more detailed response."
    }
  ];
}

message ${config.method}Response {
  string message = 1;
}
`;
}

function renderRuntimeTemplate(config) {
  return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeFromFile,
  runMain,
  type HandlerMap
} from "cmdproto";

export const METHOD_NAME = "${config.protoPackage}.${config.service}.${config.method}";
export const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/schema.binpb"
);
export const MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/runtime.binpb"
);

export const handlers: HandlerMap = {
  [METHOD_NAME](params) {
    const input = String(params.input ?? "");

    // Replace this stub with real application logic from the consumer repo.
    return {
      message: params.verbose ? \`[verbose] \${input}\` : input
    };
  }
};

export function createAppRuntime(
  schemaPath = SCHEMA_PATH,
  manifestPath = MANIFEST_PATH
) {
  return createRuntimeFromFile(handlers, schemaPath, manifestPath);
}

if (process.argv[1] && process.argv[1].endsWith("app.mts")) {
  await runMain({
    handlers,
    schemaPath: SCHEMA_PATH,
    manifestPath: MANIFEST_PATH
  });
}
`;
}

function renderTsconfig() {
  return `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.mts"]
}
`;
}

function normalizeToken(value) {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "app";
}

function resolveRuntime(runtime, packageJson, tsconfigPath) {
  if (runtime === "ts") {
    return "ts";
  }
  if (runtime === "none") {
    return "none";
  }
  if (runtime !== "auto") {
    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  if (existsSync(tsconfigPath)) {
    return "ts";
  }

  const dependencyNames = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {})
  ]);

  if (dependencyNames.has("typescript") || dependencyNames.has("tsx")) {
    return "ts";
  }

  return "none";
}

function toPascalCase(value) {
  const words = value.match(/[A-Za-z0-9]+/g) ?? [];
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "App";
}

function toKebabCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "run";
}

function escapeProto(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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
    "Usage: cmdproto-setup init [options]",
    "",
    "Options:",
    "  --cwd <dir>            Consumer repository root",
    "  --buf-config-name <n>  Buf config filename, default: buf.yaml",
    "  --app-name <name>      App name used for defaults",
    "  --proto-package <pkg>  Protobuf package, for example consumer.v1",
    "  --runtime <kind>       Runtime template: auto, ts, or none",
    "  --service <name>       Service name, for example ConsumerService",
    "  --method <name>        RPC name, for example Run",
    "  --command <path>       Human command path, for example run",
    "  --summary <text>       Command summary",
    "  --force                Overwrite generated files",
    "  --help                 Show this message"
  ].join("\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
