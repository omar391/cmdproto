import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { FISH_MANAGED_MARKER, POSIX_BLOCK_BEGIN, POSIX_BLOCK_END } from "../scripts/lib/install-path.mjs";
import { LAUNCHER_MARKER } from "../scripts/lib/install-launcher.mjs";

const CLI = join(process.cwd(), "scripts/cmdproto.mjs");
const temporaryRoots: string[] = [];

interface World {
  readonly root: string;
  readonly home: string;
  readonly caller: string;
  readonly tools: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Build an isolated world: a temporary home, a caller directory, stub package
 * managers, and a restricted PATH. Nothing here can reach the real user home,
 * shell configuration, or PATH.
 */
function isolatedWorld(options: { shell?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "cmdproto-install-test-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const caller = join(root, "caller");
  const tools = join(root, "tools");
  mkdirSync(home, { recursive: true });
  mkdirSync(caller, { recursive: true });
  mkdirSync(tools, { recursive: true });
  for (const manager of ["npm", "bun", "pnpm", "yarn"]) {
    const stub = join(tools, manager);
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "echo \"$0:$*\"",
        "echo \"cwd:$(pwd)\"",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SHELL: options.shell ?? "/bin/zsh",
    PATH: [tools, join(process.execPath, ".."), "/usr/bin", "/bin"].join(delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  return { root, home, caller, tools, env };
}

function writeConsumer(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function runCli(args: readonly string[], world: World, cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? world.caller,
    env: world.env,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function parseResult(result: { status: number | null; stdout: string; stderr: string }): Record<string, any> {
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function parseError(result: { status: number | null; stdout: string; stderr: string }): Record<string, any> {
  assert.equal(result.stdout, "");
  return JSON.parse(result.stderr);
}

function launcherPath(world: World, command: string): string {
  return join(world.home, ".local", "bin", command);
}

const CONSUMER_MANIFEST = {
  name: "consumer",
  scripts: { "cmdproto:run": "node app.mjs" },
  cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
};

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("cmdproto install CLI", () => {
  it("lists install and uninstall in root help", () => {
    const world = isolatedWorld();
    const result = runCli(["--help"], world);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /install\s+Install a source-backed launcher for this checkout/);
    assert.match(result.stdout, /uninstall\s+Remove this checkout.s cmdproto-managed launcher/);
  });

  it("prints side-effect-free subcommand help", () => {
    const world = isolatedWorld();
    for (const command of ["install", "uninstall"]) {
      const result = runCli([command, "--help"], world);
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp("Usage: cmdproto " + command + " \\[options\\]"));
    }
    assert.equal(existsSync(join(world.home, ".zshrc")), false);
    assert.equal(existsSync(join(world.home, ".local")), false);
  });

  it("rejects unknown options, duplicates, missing values, and stray positionals", () => {
    const world = isolatedWorld();
    for (const args of [["install", "--nope"], ["install", "--cwd"], ["install", "stray"]]) {
      const result = runCli(args as string[], world);
      assert.equal(result.status, 2);
      assert.equal(parseError(result).error.code, "INVALID_USAGE");
    }
    const duplicate = runCli(["install", "--cwd", world.caller, "--cwd", world.caller], world);
    assert.equal(duplicate.status, 2);
    assert.match(parseError(duplicate).error.message, /at most once/);
  });

  it("rejects options that belong to the other command", () => {
    const world = isolatedWorld();
    for (const args of [["uninstall", "--force"], ["uninstall", "--run-script", "x"], ["uninstall", "--source-env", "APP_SRC"]]) {
      const result = runCli(args, world);
      assert.equal(result.status, 2);
      assert.equal(parseError(result).error.code, "INVALID_USAGE");
    }
  });
});

describe("cmdproto install resolution", () => {
  it("requires a package.json in the directory or an ancestor", () => {
    const world = isolatedWorld();
    const result = runCli(["install"], world);
    assert.equal(result.status, 2);
    assert.equal(parseError(result).error.code, "REPOSITORY_NOT_FOUND");
  });

  it("reports an unusable --cwd", () => {
    const world = isolatedWorld();
    const result = runCli(["install", "--cwd", join(world.root, "missing")], world);
    assert.equal(result.status, 2);
    assert.equal(parseError(result).error.code, "INVALID_CWD");
  });

  it("requires a configured run script", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, { name: "consumer", scripts: {} });
    const result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 2);
    assert.equal(parseError(result).error.code, "RUN_SCRIPT_REQUIRED");
  });

  it("reports an unknown run script", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, {
      name: "consumer",
      scripts: { "cmdproto:run": "node app.mjs" },
      cmdproto: { install: { command: "consumer-cli", runScript: "missing:script" } },
    });
    const result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 2);
    assert.equal(parseError(result).error.code, "RUN_SCRIPT_NOT_FOUND");
  });

  it("rejects an unsupported package manager", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, {
      name: "consumer",
      packageManager: "corepack@1",
      scripts: { "cmdproto:run": "node app.mjs" },
      cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
    });
    const result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 2);
    assert.equal(parseError(result).error.code, "PACKAGE_MANAGER_UNSUPPORTED");
  });

  it("rejects unsafe command names without creating paths", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER_MANIFEST);
    for (const name of ["a/b", "a b", "trail.", "CON", "LPT1", "..", "--x", "ünï", ""]) {
      const result = runCli(["install", "--cwd", consumer, "--name", name], world);
      assert.equal(result.status, 2, "expected a rejection for " + JSON.stringify(name));
      assert.equal(parseError(result).error.code, "INVALID_COMMAND_NAME");
    }
    assert.equal(existsSync(join(world.home, ".local")), false);
  });

  it("prefers flags over configuration field by field", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, {
      name: "consumer",
      packageManager: "bun@1.4.0",
      scripts: { "cmdproto:run": "bun app.mts", "alt:run": "bun alt.mts" },
      cmdproto: { install: { command: "fromconfig", runScript: "cmdproto:run", sourceEnv: "CONFIG_SRC" } },
    });
    const payload = parseResult(runCli(["install", "--cwd", consumer, "--name", "fromflag", "--run-script", "alt:run", "--source-env", "FLAG_SRC"], world));
    assert.equal(payload.command, "fromflag");
    const launcher = readFileSync(launcherPath(world, "fromflag"), "utf8");
    assert.match(launcher, /"runScript":"alt:run"/);
    assert.match(launcher, /"packageManager":"bun"/);
    assert.match(launcher, /"sourceEnv":"FLAG_SRC"/);
  });

  it("rejects invalid source environment variable names", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER_MANIFEST);
    for (const sourceEnv of ["", "1SOURCE", "SOURCE-NAME", "SOURCE NAME"]) {
      const result = runCli(["install", "--cwd", consumer, "--source-env", sourceEnv], world);
      assert.equal(result.status, 2);
      assert.equal(parseError(result).error.code, "INVALID_INSTALL_CONFIG");
    }
    writeConsumer(consumer, {
      ...CONSUMER_MANIFEST,
      cmdproto: { install: { ...CONSUMER_MANIFEST.cmdproto.install, sourceEnv: "BAD-NAME" } },
    });
    const configured = runCli(["install", "--cwd", consumer], world);
    assert.equal(configured.status, 2);
    assert.equal(parseError(configured).error.code, "INVALID_INSTALL_CONFIG");
  });

  it("looks upward to the nearest package.json", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER_MANIFEST);
    const nested = join(consumer, "packages", "inner", "src");
    mkdirSync(nested, { recursive: true });
    const payload = parseResult(runCli(["install", "--cwd", nested], world));
    assert.equal(payload.sourceCheckout, realpathSync(consumer));
  });
});

describe("cmdproto install launchers", () => {
  const CONSUMER = {
    name: "consumer",
    scripts: { "cmdproto:run": "node app.mjs" },
    cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
  };

  it("installs a consumer launcher that runs the configured script", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer with space");
    writeConsumer(consumer, { ...CONSUMER, packageManager: "bun@1.4.0" });
    const payload = parseResult(runCli(["install", "--cwd", consumer], world));
    assert.equal(payload.schema, "cmdproto.install-result/v1");
    assert.equal(payload.status, "installed");
    assert.equal(payload.companionPath, null);
    const launcher = launcherPath(world, "consumer-cli");
    assert.equal(statSync(launcher).mode & 0o777, 0o755);
    const executed = spawnSync(launcher, ["ünïcode ✓", "two words"], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(executed.status, 0);
    assert.match(executed.stdout, /run cmdproto:run -- ünïcode ✓ two words/);
    assert.match(executed.stdout, new RegExp("cwd:" + realpathSync(consumer)));
  });

  it("derives a command-scoped source variable and defaults to the recorded checkout", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    parseResult(runCli(["install", "--cwd", consumer, "--name", "tab.gate-x"], world));
    const launcher = launcherPath(world, "tab.gate-x");
    assert.match(readFileSync(launcher, "utf8"), /"sourceEnv":"TAB_GATE_X_SRC"/);
    const executed = spawnSync(launcher, [], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(executed.status, 0);
    assert.match(executed.stdout, new RegExp("cwd:" + realpathSync(consumer)));
  });

  it("runs from a valid source override without changing launcher ownership", () => {
    const world = isolatedWorld();
    const recorded = join(world.root, "recorded");
    const alternate = join(world.root, "worktrees", "feature");
    writeConsumer(recorded, CONSUMER);
    writeConsumer(alternate, CONSUMER);
    parseResult(runCli(["install", "--cwd", recorded], world));
    const launcher = launcherPath(world, "consumer-cli");
    const executed = spawnSync(launcher, [], {
      cwd: world.caller,
      env: { ...world.env, CONSUMER_CLI_SRC: alternate },
      encoding: "utf8",
    });
    assert.equal(executed.status, 0);
    assert.match(executed.stdout, new RegExp("cwd:" + realpathSync(alternate)));
    assert.equal(readFileSync(launcher, "utf8").includes('"sourceCheckout":' + JSON.stringify(realpathSync(recorded))), true);
  });

  it("fails closed and names an invalid source override", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    parseResult(runCli(["install", "--cwd", consumer], world));
    for (const source of ["", join(world.root, "missing-worktree")]) {
      const executed = spawnSync(launcherPath(world, "consumer-cli"), [], {
        cwd: world.caller,
        env: { ...world.env, CONSUMER_CLI_SRC: source },
        encoding: "utf8",
      });
      assert.equal(executed.status, 66);
      assert.match(executed.stderr, /CONSUMER_CLI_SRC source override is missing/);
    }
  });

  it("honors a configured source environment variable name", () => {
    const world = isolatedWorld();
    const recorded = join(world.root, "recorded");
    const alternate = join(world.root, "alternate");
    const configured = {
      ...CONSUMER,
      cmdproto: { install: { ...CONSUMER.cmdproto.install, sourceEnv: "TABGATE_WORKTREE" } },
    };
    writeConsumer(recorded, configured);
    writeConsumer(alternate, configured);
    parseResult(runCli(["install", "--cwd", recorded], world));
    const executed = spawnSync(launcherPath(world, "consumer-cli"), [], {
      cwd: world.caller,
      env: { ...world.env, TABGATE_WORKTREE: alternate },
      encoding: "utf8",
    });
    assert.equal(executed.status, 0);
    assert.match(executed.stdout, new RegExp("cwd:" + realpathSync(alternate)));
  });

  it("preserves child streams and the exact exit code", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    parseResult(runCli(["install", "--cwd", consumer], world));
    const stub = join(world.tools, "npm");
    writeFileSync(stub, "#!/bin/sh\necho out-line\necho err-line >&2\nexit 42\n");
    chmodSync(stub, 0o755);
    const executed = spawnSync(launcherPath(world, "consumer-cli"), [], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(executed.status, 42);
    assert.equal(executed.stdout.trim(), "out-line");
    assert.equal(executed.stderr.trim(), "err-line");
  });

  it("fails with exit 66 when the checkout is gone or the script disappears", () => {
    const world = isolatedWorld();
    const moved = join(world.root, "moved");
    writeConsumer(moved, CONSUMER);
    parseResult(runCli(["install", "--cwd", moved], world));
    const launched = launcherPath(world, "consumer-cli");
    rmSync(moved, { recursive: true, force: true });
    const missing = spawnSync(launched, [], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(missing.status, 66);
    assert.match(missing.stderr, /source checkout is missing/);

    const second = isolatedWorld();
    const consumer = join(second.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    parseResult(runCli(["install", "--cwd", consumer], second));
    writeConsumer(consumer, { name: "consumer", scripts: {} });
    const noScript = spawnSync(launcherPath(second, "consumer-cli"), [], { cwd: second.caller, env: second.env, encoding: "utf8" });
    assert.equal(noScript.status, 66);
    assert.match(noScript.stderr, /no longer defines the cmdproto:run script/);
  });

  it("fails with exit 127 when the package manager is unavailable", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, { ...CONSUMER, packageManager: "pnpm@9" });
    parseResult(runCli(["install", "--cwd", consumer], world));
    rmSync(join(world.tools, "pnpm"));
    const executed = spawnSync(launcherPath(world, "consumer-cli"), [], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(executed.status, 127);
    assert.match(executed.stderr, /pnpm was not found on PATH/);
  });

  it("builds manager-specific arguments", () => {
    const cases: ReadonlyArray<readonly [string | undefined, RegExp]> = [
      ["bun@1.4.0", /run cmdproto:run -- one/],
      ["pnpm@9", /run cmdproto:run -- one/],
      ["yarn@4", /run cmdproto:run one/],
      [undefined, /run cmdproto:run -- one/],
    ];
    for (const [manager, expected] of cases) {
      const world = isolatedWorld();
      const consumer = join(world.root, "consumer");
      writeConsumer(consumer, manager === undefined ? CONSUMER : { ...CONSUMER, packageManager: manager });
      parseResult(runCli(["install", "--cwd", consumer], world));
      const executed = spawnSync(launcherPath(world, "consumer-cli"), ["one"], { cwd: world.caller, env: world.env, encoding: "utf8" });
      assert.equal(executed.status, 0);
      assert.match(executed.stdout, expected);
    }
  });

  it("refuses to install when the package manager is not on PATH", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, { ...CONSUMER, packageManager: "pnpm@9" });
    rmSync(join(world.tools, "pnpm"));
    const result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 4);
    assert.equal(parseError(result).error.code, "PACKAGE_MANAGER_NOT_FOUND");
  });
});

describe("cmdproto self installation", () => {
  it("installs cmdproto itself and keeps the caller directory", () => {
    const world = isolatedWorld();
    const payload = parseResult(runCli(["install", "--cwd", process.cwd(), "--name", "cmdproto-test"], world));
    assert.equal(payload.status, "installed");
    const launcher = launcherPath(world, "cmdproto-test");
    const help = spawnSync(launcher, ["--help"], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: cmdproto <command> \[options\]/);
    const target = join(world.root, "fresh-consumer");
    mkdirSync(target, { recursive: true });
    const init = spawnSync(launcher, ["init", "--cwd", target, "--app-name", "fresh"], { cwd: world.caller, env: world.env, encoding: "utf8" });
    assert.equal(init.status, 0);
    assert.equal(existsSync(join(target, "package.json")), true);
    assert.equal(existsSync(join(world.caller, "package.json")), false);
  });

  it("rejects --run-script in the cmdproto checkout", () => {
    const world = isolatedWorld();
    const result = runCli(["install", "--cwd", process.cwd(), "--run-script", "x"], world);
    assert.equal(result.status, 2);
    assert.equal(parseError(result).error.code, "INVALID_USAGE");
  });
});

describe("cmdproto install safety", () => {
  const CONSUMER = {
    name: "consumer",
    scripts: { "cmdproto:run": "node app.mjs" },
    cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
  };

  function installConsumer(world: World, extra: readonly string[] = []): Record<string, any> {
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    return parseResult(runCli(["install", "--cwd", consumer, ...extra], world));
  }

  it("is idempotent and refreshes when configuration changed", () => {
    const world = isolatedWorld();
    assert.equal(installConsumer(world).status, "installed");
    assert.equal(installConsumer(world).status, "unchanged");
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, { ...CONSUMER, packageManager: "bun@1" });
    assert.equal(parseResult(runCli(["install", "--cwd", consumer], world)).status, "refreshed");
  });

  it("refuses a foreign file and a symlink at the launcher target", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const binDirectory = join(world.home, ".local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(launcherPath(world, "consumer-cli"), "not a launcher\n");
    let result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 3);
    assert.equal(parseError(result).error.code, "FOREIGN_TARGET");
    result = runCli(["install", "--cwd", consumer, "--force"], world);
    assert.equal(result.status, 3, "--force must not bypass foreign-file protection");
    assert.equal(readFileSync(launcherPath(world, "consumer-cli"), "utf8"), "not a launcher\n");

    rmSync(launcherPath(world, "consumer-cli"));
    symlinkSync(join(world.root, "elsewhere"), launcherPath(world, "consumer-cli"));
    result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 3);
    assert.equal(parseError(result).error.code, "FOREIGN_TARGET");
  });

  it("requires --force to replace another checkout and to shadow a PATH command", () => {
    const world = isolatedWorld();
    const first = join(world.root, "first");
    const second = join(world.root, "second");
    writeConsumer(first, CONSUMER);
    writeConsumer(second, CONSUMER);
    assert.equal(parseResult(runCli(["install", "--cwd", first], world)).status, "installed");
    const blocked = runCli(["install", "--cwd", second], world);
    assert.equal(blocked.status, 3);
    assert.equal(parseError(blocked).error.code, "OWNED_BY_OTHER_CHECKOUT");
    assert.equal(parseResult(runCli(["install", "--cwd", second, "--force"], world)).status, "refreshed");

    const shadowWorld = isolatedWorld();
    const shadow = join(shadowWorld.tools, "consumer-cli");
    writeFileSync(shadow, "#!/bin/sh\necho packaged\n");
    chmodSync(shadow, 0o755);
    const consumer = join(shadowWorld.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const blockedShadow = runCli(["install", "--cwd", consumer], shadowWorld);
    assert.equal(blockedShadow.status, 3);
    assert.equal(parseError(blockedShadow).error.code, "PATH_COMMAND_COLLISION");
    assert.equal(parseResult(runCli(["install", "--cwd", consumer, "--force"], shadowWorld)).status, "installed");
    const packaged = spawnSync(shadow, [], { encoding: "utf8" });
    assert.equal(packaged.stdout.trim(), "packaged");
  });

  it("uninstalls only managed launchers and reveals a shadowed command", () => {
    const world = isolatedWorld();
    const shadow = join(world.tools, "consumer-cli");
    writeFileSync(shadow, "#!/bin/sh\necho packaged\n");
    chmodSync(shadow, 0o755);
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    parseResult(runCli(["install", "--cwd", consumer, "--force"], world));
    const removed = parseResult(runCli(["uninstall", "--cwd", consumer], world));
    assert.equal(removed.status, "uninstalled");
    assert.equal(removed.pathAction.action, "retained");
    assert.equal(existsSync(launcherPath(world, "consumer-cli")), false);
    assert.equal(existsSync(shadow), true, "an unrelated packaged command must survive");
    assert.equal(readFileSync(join(world.home, ".zshrc"), "utf8").includes(POSIX_BLOCK_BEGIN), true);
    assert.equal(parseResult(runCli(["uninstall", "--cwd", consumer], world)).status, "absent");
  });

  it("refuses to uninstall a launcher owned by another checkout", () => {
    const world = isolatedWorld();
    const first = join(world.root, "first");
    const second = join(world.root, "second");
    writeConsumer(first, CONSUMER);
    writeConsumer(second, CONSUMER);
    parseResult(runCli(["install", "--cwd", first], world));
    const result = runCli(["uninstall", "--cwd", second], world);
    assert.equal(result.status, 3);
    assert.equal(parseError(result).error.code, "OWNED_BY_OTHER_CHECKOUT");
    assert.equal(existsSync(launcherPath(world, "consumer-cli")), true);
  });

  it("refuses to uninstall an unmanaged file", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const binDirectory = join(world.home, ".local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(launcherPath(world, "consumer-cli"), "mine\n");
    const result = runCli(["uninstall", "--cwd", consumer], world);
    assert.equal(result.status, 3);
    assert.equal(parseError(result).error.code, "FOREIGN_TARGET");
    assert.equal(readFileSync(launcherPath(world, "consumer-cli"), "utf8"), "mine\n");
  });

  it("does not accept a metadata marker alone as ownership", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const binDirectory = join(world.home, ".local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    const forged = [
      "#!/usr/bin/env node",
      "// " + LAUNCHER_MARKER + " " + JSON.stringify({
        schema: "cmdproto.launcher/v1",
        owner: "cmdproto",
        command: "consumer-cli",
        kind: "consumer",
        sourceCheckout: realpathSync(consumer),
        entry: null,
        runScript: "cmdproto:run",
        packageManager: "npm",
      }),
      "console.log(\"hijacked\");",
      "",
    ].join("\n");
    writeFileSync(launcherPath(world, "consumer-cli"), forged);
    const result = runCli(["install", "--cwd", consumer, "--force"], world);
    assert.equal(result.status, 3);
    assert.equal(parseError(result).error.code, "FOREIGN_TARGET");
  });
});

describe("cmdproto install PATH persistence", () => {
  const CONSUMER = {
    name: "consumer",
    scripts: { "cmdproto:run": "node app.mjs" },
    cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
  };

  function installIn(world: World): Record<string, any> {
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    return parseResult(runCli(["install", "--cwd", consumer], world));
  }

  it("adds one managed block to the detected shell file only", () => {
    const world = isolatedWorld({ shell: "/bin/zsh" });
    const payload = installIn(world);
    assert.equal(payload.pathAction.shell, "zsh");
    assert.equal(payload.pathAction.action, "added");
    assert.equal(payload.pathAction.target, join(world.home, ".zshrc"));
    assert.equal(payload.newShellRequired, true);
    const zshrc = readFileSync(join(world.home, ".zshrc"), "utf8");
    assert.equal(zshrc.includes(POSIX_BLOCK_BEGIN), true);
    assert.equal(zshrc.includes(POSIX_BLOCK_END), true);
    assert.equal(existsSync(join(world.home, ".bashrc")), false);
    assert.equal(existsSync(join(world.home, ".profile")), false);
    assert.equal(parseResult(runCli(["install", "--cwd", join(world.root, "consumer")], world)).pathAction.action, "unchanged");
  });

  it("preserves existing content and consolidates duplicate blocks", () => {
    const world = isolatedWorld({ shell: "/bin/bash" });
    const bashrc = join(world.home, ".bashrc");
    writeFileSync(bashrc, "export EDITOR=vim\n");
    installIn(world);
    assert.match(readFileSync(bashrc, "utf8"), /export EDITOR=vim/);
    writeFileSync(
      bashrc,
      [POSIX_BLOCK_BEGIN, "export PATH=stale", POSIX_BLOCK_END, "keep=1", POSIX_BLOCK_BEGIN, "export PATH=stale2", POSIX_BLOCK_END, ""].join("\n")
    );
    const payload = parseResult(runCli(["install", "--cwd", join(world.root, "consumer")], world));
    assert.equal(payload.pathAction.action, "updated");
    const updated = readFileSync(bashrc, "utf8");
    assert.equal(updated.split(POSIX_BLOCK_BEGIN).length - 1, 1);
    assert.match(updated, /keep=1/);
  });

  it("refuses an incomplete managed block", () => {
    const world = isolatedWorld({ shell: "/bin/zsh" });
    writeFileSync(join(world.home, ".zshrc"), POSIX_BLOCK_BEGIN + "\nexport PATH=x\n");
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 4);
    assert.equal(parseError(result).error.code, "SHELL_CONFIG_CONFLICT");
  });

  it("writes fish configuration and falls back to .profile", () => {
    const fishWorld = isolatedWorld({ shell: "/usr/bin/fish" });
    const fishPayload = installIn(fishWorld);
    assert.equal(fishPayload.pathAction.shell, "fish");
    const fishFile = join(fishWorld.home, ".config", "fish", "conf.d", "cmdproto-path.fish");
    assert.match(readFileSync(fishFile, "utf8"), /fish_add_path --prepend --move/);

    const profileWorld = isolatedWorld({ shell: "/bin/dash" });
    const profilePayload = installIn(profileWorld);
    assert.equal(profilePayload.pathAction.shell, "profile");
    assert.equal(profilePayload.pathAction.target, join(profileWorld.home, ".profile"));
  });

  it("refuses to overwrite an unmanaged fish configuration", () => {
    const world = isolatedWorld({ shell: "/usr/bin/fish" });
    const fishFile = join(world.home, ".config", "fish", "conf.d", "cmdproto-path.fish");
    mkdirSync(join(world.home, ".config", "fish", "conf.d"), { recursive: true });
    writeFileSync(fishFile, "set -gx EDITOR vim\n");
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const result = runCli(["install", "--cwd", consumer], world);
    assert.equal(result.status, 4);
    assert.equal(parseError(result).error.code, "SHELL_CONFIG_CONFLICT");
    assert.equal(readFileSync(fishFile, "utf8"), "set -gx EDITOR vim\n");
  });

  it("only accepts the exact managed fish file", () => {
    const variants = [
      FISH_MANAGED_MARKER + "\n",
      FISH_MANAGED_MARKER + "\nfish_add_path --prepend --move \"$HOME/.local/bin\"\nset -gx EDITOR vim\n",
      "set -gx EDITOR vim\n" + FISH_MANAGED_MARKER + "\n",
    ];
    for (const contents of variants) {
      const world = isolatedWorld({ shell: "/usr/bin/fish" });
      const fishFile = join(world.home, ".config", "fish", "conf.d", "cmdproto-path.fish");
      mkdirSync(join(world.home, ".config", "fish", "conf.d"), { recursive: true });
      writeFileSync(fishFile, contents);
      const consumer = join(world.root, "consumer");
      writeConsumer(consumer, CONSUMER);
      const result = runCli(["install", "--cwd", consumer], world);
      assert.equal(result.status, 4);
      assert.equal(parseError(result).error.code, "SHELL_CONFIG_CONFLICT");
      assert.equal(readFileSync(fishFile, "utf8"), contents);
    }
  });

  it("refuses regular and dangling shell-config symlinks without replacing them", () => {
    for (const dangling of [false, true]) {
      const world = isolatedWorld({ shell: "/bin/zsh" });
      const referent = join(world.root, dangling ? "missing-zshrc" : "shared-zshrc");
      if (!dangling) writeFileSync(referent, "export EDITOR=vim\n");
      const zshrc = join(world.home, ".zshrc");
      symlinkSync(referent, zshrc);
      const consumer = join(world.root, "consumer");
      writeConsumer(consumer, CONSUMER);
      const result = runCli(["install", "--cwd", consumer], world);
      assert.equal(result.status, 4);
      assert.equal(parseError(result).error.code, "SHELL_CONFIG_CONFLICT");
      assert.equal(readlinkSync(zshrc), referent);
      if (!dangling) assert.equal(readFileSync(referent, "utf8"), "export EDITOR=vim\n");
      else assert.equal(existsSync(referent), false);
    }
  });

  it("reports newShellRequired false when the bin directory is already on PATH", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const withBin = { ...world.env, PATH: join(world.home, ".local", "bin") + delimiter + world.env.PATH };
    const result = spawnSync(process.execPath, [CLI, "install", "--cwd", consumer], { cwd: world.caller, env: withBin, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).newShellRequired, false);
  });
});

describe("cmdproto init configuration", () => {
  it("records the command and run script for the TypeScript runtime", () => {
    const world = isolatedWorld();
    const target = join(world.root, "fresh app");
    mkdirSync(target, { recursive: true });
    const init = runCli(["init", "--cwd", target, "--app-name", "fresh-demo", "--runtime", "ts"], world);
    assert.equal(init.status, 0);
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(manifest.cmdproto.install.command, "fresh_demo");
    assert.equal(manifest.cmdproto.install.runScript, "cmdproto:run");
    assert.equal(typeof manifest.scripts["cmdproto:run"], "string");
    const installed = parseResult(runCli(["install", "--cwd", target], world));
    assert.equal(installed.command, "fresh_demo");
    assert.equal(existsSync(launcherPath(world, "fresh_demo")), true);
  });

  it("does not add install configuration for the none runtime", () => {
    const world = isolatedWorld();
    const target = join(world.root, "plain");
    mkdirSync(target, { recursive: true });
    const init = runCli(["init", "--cwd", target, "--app-name", "plain", "--runtime", "none"], world);
    assert.equal(init.status, 0);
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(manifest.cmdproto, undefined);
  });
});

describe("cmdproto uninstall independence", () => {
  it("removes a launcher even after the configuration changed", () => {
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, {
      name: "consumer",
      scripts: { "cmdproto:run": "node app.mjs" },
      cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
    });
    parseResult(runCli(["install", "--cwd", consumer], world));
    // The script and the configuration entry are both gone, but --name still
    // identifies the launcher, so uninstall must not require either of them.
    writeConsumer(consumer, { name: "consumer", scripts: {} });
    const removed = parseResult(runCli(["uninstall", "--cwd", consumer, "--name", "consumer-cli"], world));
    assert.equal(removed.status, "uninstalled");
    assert.equal(existsSync(launcherPath(world, "consumer-cli")), false);
  });
});

describe("cmdproto install Windows behavior", () => {
  const CONSUMER = {
    name: "consumer",
    scripts: { "cmdproto:run": "node app.mjs" },
    cmdproto: { install: { command: "consumer-cli", runScript: "cmdproto:run" } },
  };

  async function runWindowsInstall(
    world: World,
    args: readonly string[],
    pathExt: string,
  ): Promise<{ code: number; output: Record<string, any> }> {
    const commandModule = await import("../scripts/lib/install-command.mjs");
    const windowsTools = join(world.root, "win-tools");
    mkdirSync(windowsTools, { recursive: true });
    writeFileSync(join(windowsTools, "npm.cmd"), "@echo off\n");
    let storedPath = "C:\\Windows";
    const windowsPath = { read: () => storedPath, write: (value: string) => { storedPath = value; } };
    const captured: string[] = [];
    const stream = { write: (chunk: string) => { captured.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
    const code = commandModule.runInstall(args, {
      platform: "win32",
      home: world.home,
      env: { ...world.env, PATH: windowsTools, PATHEXT: pathExt },
      windowsPath,
      stdout: stream,
      stderr: stream,
    });
    return { code, output: JSON.parse(captured.join("")) };
  }

  /** Render and inspect the pair without needing a Windows host. */
  it("renders a .cmd entry with a managed companion", async () => {
    const { buildLauncherPlan, inspectLauncherTargets, parseLauncherMetadata } = await import("../scripts/lib/install-launcher.mjs");
    const resolved = {
      selfMode: false,
      checkout: "/checkout",
      selfEntry: null,
      runScript: "cmdproto:run",
      packageManager: "npm",
    };
    const plan = buildLauncherPlan("consumer-cli", resolved, "/home/.local/bin", "win32");
    assert.equal(plan.primaryPath.endsWith("consumer-cli.cmd"), true);
    assert.equal(plan.companionPath?.endsWith("consumer-cli.cmdproto.cjs"), true);
    assert.match(plan.primaryContents, /^@echo off/);
    assert.match(plan.primaryContents, /node "%~dp0consumer-cli.cmdproto.cjs" %\*/);
    assert.match(plan.primaryContents, /exit \/b %ERRORLEVEL%/);
    assert.match(String(plan.companionContents), /"kind":"consumer"/);
    assert.equal(parseLauncherMetadata(plan.primaryContents)?.command, "consumer-cli");
    assert.deepEqual(inspectLauncherTargets(plan).state, "absent");
  });

  it("treats independently valid Windows launchers with different metadata as partial", async () => {
    const { buildLauncherPlan, inspectLauncherTargets } = await import("../scripts/lib/install-launcher.mjs");
    const binDirectory = join(isolatedWorld().home, ".local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    const first = buildLauncherPlan("consumer-cli", {
      selfMode: false,
      checkout: "/checkout/one",
      selfEntry: null,
      runScript: "cmdproto:run",
      packageManager: "npm",
    }, binDirectory, "win32");
    const second = buildLauncherPlan("consumer-cli", {
      selfMode: false,
      checkout: "/checkout/two",
      selfEntry: null,
      runScript: "other:run",
      packageManager: "pnpm",
    }, binDirectory, "win32");
    writeFileSync(first.primaryPath, first.primaryContents);
    writeFileSync(String(first.companionPath), String(second.companionContents));
    assert.equal(inspectLauncherTargets(first).state, "partial");
  });

  it("uses the Windows command host for package-manager shims and preserves exit status", async () => {
    const { buildLauncherPlan } = await import("../scripts/lib/install-launcher.mjs");
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const binDirectory = join(world.home, ".local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    const plan = buildLauncherPlan("consumer-cli", {
      selfMode: false,
      checkout: realpathSync(consumer),
      selfEntry: null,
      runScript: "cmdproto:run",
      packageManager: "npm",
    }, binDirectory, "win32");
    writeFileSync(String(plan.companionPath), String(plan.companionContents));
    const manager = join(world.tools, "npm.cmd");
    writeFileSync(manager, "@echo off\n");
    const commandHost = join(world.tools, "cmd.exe");
    writeFileSync(commandHost, "#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 37\n");
    chmodSync(commandHost, 0o755);
    const preload = join(world.root, "windows-platform.cjs");
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    const executed = spawnSync(process.execPath, ["--require", preload, String(plan.companionPath), "two words"], {
      cwd: world.caller,
      env: { ...world.env, ComSpec: commandHost, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      encoding: "utf8",
    });
    assert.equal(executed.status, 37);
    assert.match(executed.stdout, /^\/d\n\/s\n\/c\n/m);
    assert.match(executed.stdout, /npm\.cmd/);
    assert.match(executed.stdout, /cmdproto:run/);
    assert.match(executed.stdout, /two words/);
  });

  it("refuses higher-precedence .com, .exe, and .bat collisions even with --force", async () => {
    for (const extension of [".com", ".exe", ".bat"]) {
      const world = isolatedWorld();
      const consumer = join(world.root, "consumer");
      writeConsumer(consumer, CONSUMER);
      const binDirectory = join(world.home, ".local", "bin");
      mkdirSync(binDirectory, { recursive: true });
      const collision = join(binDirectory, "consumer-cli" + extension);
      writeFileSync(collision, "foreign\n");
      const result = await runWindowsInstall(
        world,
        ["--cwd", consumer, "--force"],
        ".COM;.EXE;.BAT;.CMD",
      );
      assert.equal(result.code, 3, extension);
      assert.equal(result.output.error.code, "PATH_COMMAND_COLLISION");
      assert.equal(result.output.error.details.path, collision);
      assert.match(result.output.error.message, /takes precedence/);
      assert.equal(existsSync(join(binDirectory, "consumer-cli.cmd")), false);
      assert.equal(readFileSync(collision, "utf8"), "foreign\n");
    }
  });

  it("uses PATHEXT order to decide whether --force can shadow a same-bin candidate", async () => {
    const lowerWorld = isolatedWorld();
    const lowerConsumer = join(lowerWorld.root, "consumer");
    writeConsumer(lowerConsumer, CONSUMER);
    const lowerBin = join(lowerWorld.home, ".local", "bin");
    mkdirSync(lowerBin, { recursive: true });
    writeFileSync(join(lowerBin, "consumer-cli.exe"), "foreign\n");
    let result = await runWindowsInstall(
      lowerWorld,
      ["--cwd", lowerConsumer],
      ".CMD;.EXE",
    );
    assert.equal(result.code, 3);
    assert.equal(result.output.error.code, "PATH_COMMAND_COLLISION");
    result = await runWindowsInstall(
      lowerWorld,
      ["--cwd", lowerConsumer, "--force"],
      ".CMD;.EXE",
    );
    assert.equal(result.code, 0);
    assert.equal(result.output.status, "installed");
    assert.equal(existsSync(join(lowerBin, "consumer-cli.cmd")), true);

    const higherWorld = isolatedWorld();
    const higherConsumer = join(higherWorld.root, "consumer");
    writeConsumer(higherConsumer, CONSUMER);
    const higherBin = join(higherWorld.home, ".local", "bin");
    mkdirSync(higherBin, { recursive: true });
    writeFileSync(join(higherBin, "consumer-cli.exe"), "foreign\n");
    result = await runWindowsInstall(
      higherWorld,
      ["--cwd", higherConsumer, "--force"],
      ".EXE;.CMD",
    );
    assert.equal(result.code, 3);
    assert.equal(result.output.error.code, "PATH_COMMAND_COLLISION");
  });

  it("installs and removes the pair through the command with a mocked user Path", async () => {
    const launcherModule = await import("../scripts/lib/install-launcher.mjs");
    const commandModule = await import("../scripts/lib/install-command.mjs");
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer with space");
    writeConsumer(consumer, CONSUMER);

    // Windows resolves executables through PATHEXT, so the fixture package
    // manager must carry a real extension.
    const windowsTools = join(world.root, "win-tools");
    mkdirSync(windowsTools, { recursive: true });
    writeFileSync(join(windowsTools, "npm.cmd"), "@echo off\n");

    let storedPath = "C:\\Windows;C:\\Tools";
    const windowsPath = { read: () => storedPath, write: (value: string) => { storedPath = value; } };
    const captured: string[] = [];
    const stdout = { write: (chunk: string) => { captured.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
    const stderr = { write: (chunk: string) => { captured.push(chunk); return true; } } as unknown as NodeJS.WritableStream;

    const installCode = commandModule.runInstall(["--cwd", consumer], {
      platform: "win32",
      home: world.home,
      env: {
        ...world.env,
        PATH: [windowsTools, join(world.home, ".local", "bin")].join(delimiter),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      windowsPath,
      stdout,
      stderr,
    });
    assert.equal(installCode, 0);
    const payload = JSON.parse(captured.join(""));
    assert.equal(payload.schema, "cmdproto.install-result/v1");
    assert.equal(payload.status, "installed");
    assert.equal(payload.pathAction.shell, "windows");
    assert.equal(payload.pathAction.target, "user:Path");
    assert.equal(storedPath.startsWith("%USERPROFILE%\\.local\\bin;"), true);
    assert.equal(storedPath.endsWith("C:\\Windows;C:\\Tools"), true);

    const primary = String(payload.launcherPath);
    const companionValue = payload.companionPath;
    assert.equal(typeof companionValue, "string");
    const companion = String(companionValue);
    assert.equal(existsSync(primary), true);
    assert.equal(existsSync(companion), true);
    const plan = launcherModule.buildLauncherPlan(payload.command, {
      selfMode: false,
      checkout: payload.sourceCheckout,
      selfEntry: null,
      runScript: "cmdproto:run",
      packageManager: "npm",
    }, join(world.home, ".local", "bin"), "win32");
    assert.equal(launcherModule.inspectLauncherTargets(plan).state, "managed");

    // A half-written pair must block mutation rather than being treated as new.
    const saved = readFileSync(companion);
    rmSync(companion);
    assert.equal(launcherModule.inspectLauncherTargets(plan).state, "partial");
    const blocked = commandModule.runInstall(["--cwd", consumer, "--force"], {
      platform: "win32",
      home: world.home,
      env: world.env,
      windowsPath,
      stdout,
      stderr,
    });
    assert.equal(blocked, 3);
    writeFileSync(companion, saved);

    captured.length = 0;
    const uninstallCode = commandModule.runUninstall(["--cwd", consumer], {
      platform: "win32",
      home: world.home,
      env: world.env,
      windowsPath,
      stdout,
      stderr,
    });
    assert.equal(uninstallCode, 0);
    assert.equal(JSON.parse(captured.join("")).status, "uninstalled");
    assert.equal(existsSync(primary), false);
    assert.equal(existsSync(companion), false);
    assert.equal(storedPath.includes(".local"), true, "uninstall retains the shared PATH entry");
  });

  it("restores the previous companion when refreshing the Windows primary fails", async () => {
    const commandModule = await import("../scripts/lib/install-command.mjs");
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const windowsTools = join(world.root, "win-tools");
    mkdirSync(windowsTools, { recursive: true });
    writeFileSync(join(windowsTools, "npm.cmd"), "@echo off\n");
    writeFileSync(join(windowsTools, "pnpm.cmd"), "@echo off\n");
    let storedPath = "C:\\Windows";
    const captured: string[] = [];
    const stream = { write: (chunk: string) => { captured.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
    const base = {
      platform: "win32",
      home: world.home,
      env: { ...world.env, PATH: windowsTools, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      stdout: stream,
      stderr: stream,
    };
    assert.equal(commandModule.runInstall(["--cwd", consumer], {
      ...base,
      windowsPath: { read: () => storedPath, write: (value: string) => { storedPath = value; } },
    }), 0);
    const installed = JSON.parse(captured.join(""));
    const primary = String(installed.launcherPath);
    const companion = String(installed.companionPath);
    const previousCompanion = readFileSync(companion, "utf8");
    writeConsumer(consumer, { ...CONSUMER, packageManager: "pnpm@9" });
    captured.length = 0;
    let injected = false;
    const code = commandModule.runInstall(["--cwd", consumer], {
      ...base,
      windowsPath: {
        read: () => {
          if (!injected) {
            injected = true;
            rmSync(primary);
            mkdirSync(primary);
          }
          return storedPath;
        },
        write: (value: string) => { storedPath = value; },
      },
    });
    assert.equal(code, 4);
    assert.equal(JSON.parse(captured.join("")).error.code, "LAUNCHER_WRITE_FAILED");
    assert.equal(readFileSync(companion, "utf8"), previousCompanion);
  });

  it("reports a failed user Path update without claiming success", async () => {
    const commandModule = await import("../scripts/lib/install-command.mjs");
    const world = isolatedWorld();
    const consumer = join(world.root, "consumer");
    writeConsumer(consumer, CONSUMER);
    const windowsPath = {
      read: () => "C:\\Windows",
      write: () => { throw new Error("denied"); },
    };
    const captured: string[] = [];
    const stream = { write: (chunk: string) => { captured.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
    const code = commandModule.runInstall(["--cwd", consumer], {
      platform: "win32",
      home: world.home,
      env: world.env,
      windowsPath,
      stdout: stream,
      stderr: stream,
    });
    assert.equal(code, 1);
    const error = JSON.parse(captured.join(""));
    assert.equal(error.error.code, "INTERNAL_ERROR");
    assert.equal(existsSync(join(world.home, ".local", "bin", "consumer-cli.cmd")), false);
  });
});
