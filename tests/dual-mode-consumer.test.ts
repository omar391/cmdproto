import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { before, describe, it } from "node:test";

const FIXTURE_ROOT = join(process.cwd(), "examples/dual-mode-consumer");
let consumerRoot = "";

before(() => {
  execFileSync("npm", ["run", "schema:build:dual-mode"], { stdio: "ignore" });

  const packRoot = mkdtempSync(join(tmpdir(), "cmdproto-pack-"));
  const pack = JSON.parse(execFileSync("npm", [
    "pack",
    "--json",
    "--pack-destination",
    packRoot
  ], { encoding: "utf8" })) as Array<{ filename: string }>;
  const tarball = join(packRoot, pack[0]?.filename ?? "missing.tgz");
  assert.ok(existsSync(tarball), "npm pack must produce an installable tarball");

  consumerRoot = join(mkdtempSync(join(tmpdir(), "cmdproto-dual-consumer-")), basename(FIXTURE_ROOT));
  cpSync(FIXTURE_ROOT, consumerRoot, { recursive: true });
  const packagePath = join(consumerRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  packageJson.dependencies.cmdproto = `file:${tarball}`;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumerRoot,
    stdio: "ignore"
  });
});

describe("packed dual-mode consumer", () => {
  it("imports only the installed cmdproto package exports", () => {
    for (const sourceName of ["app.ts", "client.mts"]) {
      const source = readFileSync(join(consumerRoot, "src", sourceName), "utf8");
      assert.match(source, /from "cmdproto(?:\/connect(?:\/bootstrap)?)?"/);
      assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/(?:connect|runtimes)/);
    }
  });

  it("typechecks both the .ts server and .mts client against the packed artifact", () => {
    execFileSync("npm", ["run", "typecheck", "--silent"], {
      cwd: consumerRoot,
      stdio: "pipe"
    });
  });

  it("keeps server startup out of the user-facing command surface", () => {
    const help = execFileSync(process.execPath, [
      "--import",
      "tsx",
      "src/app.ts",
      "--help"
    ], {
      cwd: consumerRoot,
      encoding: "utf8"
    });

    assert.match(help, /ping/);
    assert.doesNotMatch(help, /^\s*serve\b/m);
    assert.doesNotMatch(help, /cmdproto-internal-connect/);
  });

  it("runs ensure, spawn, capability discovery, Connect Ping, and teardown", () => {
    const capabilityPath = join(
      mkdtempSync(join(tmpdir(), "cmdproto-dual-capability-")),
      "capability.json"
    );
    const stdout = execFileSync("npm", ["run", "test:lifecycle", "--silent"], {
      cwd: consumerRoot,
      encoding: "utf8",
      env: { ...process.env, CMDPROTO_CAPABILITY_PATH: capabilityPath }
    });

    assert.deepEqual(JSON.parse(stdout), { message: "Hello, Ada!" });
    assert.equal(existsSync(capabilityPath), false);
  });
});
