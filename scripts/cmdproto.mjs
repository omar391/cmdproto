#!/usr/bin/env node

import { renderUsage } from "./lib/cli-shared.mjs";
import { getBuildUsage, runBuild } from "./lib/build-command.mjs";
import {
  getInstallUsage,
  getUninstallUsage,
  runInstall,
  runUninstall
} from "./lib/install-command.mjs";
import { getInitUsage, runInit } from "./lib/init-command.mjs";

function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${getRootUsage()}\n`);
    return;
  }

  switch (command) {
    case "init":
      runInit(rest);
      return;
    case "build":
      runBuild(rest);
      return;
    case "install":
      process.exitCode = runInstall(rest);
      return;
    case "uninstall":
      process.exitCode = runUninstall(rest);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function getRootUsage() {
  return renderUsage("cmdproto <command> [options]", [
    {
      heading: "Commands",
      entries: [
        ["init", "Scaffold a consumer repo with cmdproto defaults"],
        ["build", "Generate, lint, and compile cmdproto runtime artifacts"],
        ["install", "Install a source-backed launcher for this checkout"],
        ["uninstall", "Remove this checkout's cmdproto-managed launcher"]
      ]
    },
    {
      heading: "Help",
      entries: [
        ["cmdproto init --help", getInitUsage().split("\n")[0].replace("Usage: ", "")],
        ["cmdproto build --help", getBuildUsage().split("\n")[0].replace("Usage: ", "")],
        ["cmdproto install --help", getInstallUsage().split("\n")[0].replace("Usage: ", "")],
        ["cmdproto uninstall --help", getUninstallUsage().split("\n")[0].replace("Usage: ", "")]
      ]
    }
  ]);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
