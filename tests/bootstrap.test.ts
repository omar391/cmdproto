import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
  createCmdProtoInternalServer,
  ensureCmdProtoServer,
  type CmdProtoInternalServerOptions
} from "../connect/bootstrap.js";
import { CmdProtoError, type CmdProtoRuntime } from "../runtimes/runtime.js";
import {
  createGreeterRuntime,
  GREETER_METHOD
} from "../examples/greeter/src/app.js";

type Capability = Readonly<{ service: string }>;
type FakeChild = EventEmitter & { unref(): void };
type RaceCapability = Readonly<{ baseUrl: string; pid: number }>;

const RACE_CALLER_PATH = join(
  process.cwd(),
  "tests/fixtures/bootstrap-race/caller.mts"
);
const RACE_SERVER_PATH = join(
  process.cwd(),
  "tests/fixtures/bootstrap-race/server.mjs"
);

before(() => {
  execFileSync("npm", ["run", "schema:build:greeter"], { stdio: "ignore" });
});

describe("ensureCmdProtoServer", () => {
  it("deduplicates omitted-key callers that share one capability reader", async () => {
    let capability: Capability | undefined;
    let spawnCount = 0;
    const readCapability = (): Capability | undefined => capability;
    const spawnServer = spawnStub(() => {
      spawnCount += 1;
      queueMicrotask(() => { capability = { service: "shared" }; });
      return fakeChild();
    });
    const options = {
      readCapability,
      executable: process.execPath,
      args: ["consumer-entry.mjs"],
      pollMs: 1,
      timeoutMs: 1_000,
      spawn: spawnServer
    };

    const [first, second] = await Promise.all([
      ensureCmdProtoServer<Capability>(options),
      ensureCmdProtoServer<Capability>({ ...options })
    ]);

    assert.equal(spawnCount, 1);
    assert.equal(first, second);
  });

  it("does not coalesce unrelated omitted-key services", async () => {
    let firstCapability: Capability | undefined;
    let secondCapability: Capability | undefined;
    let spawnCount = 0;

    const [first, second] = await Promise.all([
      ensureCmdProtoServer<Capability>({
        readCapability: () => firstCapability,
        pollMs: 1,
        timeoutMs: 1_000,
        spawn: spawnStub(() => {
          spawnCount += 1;
          queueMicrotask(() => { firstCapability = { service: "first" }; });
          return fakeChild();
        })
      }),
      ensureCmdProtoServer<Capability>({
        readCapability: () => secondCapability,
        pollMs: 1,
        timeoutMs: 1_000,
        spawn: spawnStub(() => {
          spawnCount += 1;
          queueMicrotask(() => { secondCapability = { service: "second" }; });
          return fakeChild();
        })
      })
    ]);

    assert.equal(spawnCount, 2);
    assert.deepEqual(first, { service: "first" });
    assert.deepEqual(second, { service: "second" });
  });

  it("converges across isolated processes when one starter loses", async () => {
    const raceRoot = mkdtempSync(join(tmpdir(), "cmdproto-bootstrap-race-"));
    const capabilityPath = join(raceRoot, "capability.json");
    const lockPath = join(raceRoot, "startup.lock");
    const attemptsPath = join(raceRoot, "attempts.log");
    const env = {
      ...process.env,
      CMDPROTO_RACE_CAPABILITY_PATH: capabilityPath,
      CMDPROTO_RACE_LOCK_PATH: lockPath,
      CMDPROTO_RACE_ATTEMPTS_PATH: attemptsPath,
      CMDPROTO_RACE_SERVER_PATH: RACE_SERVER_PATH
    };
    let capability: RaceCapability | undefined;
    let completed = false;
    const startedAt = Date.now();

    try {
      assert.equal(existsSync(capabilityPath), false);
      assert.equal(existsSync(lockPath), false);

      const [firstOutput, secondOutput] = await Promise.all([
        runIsolatedCaller(env),
        runIsolatedCaller(env)
      ]);
      const first = JSON.parse(firstOutput) as RaceCapability;
      const second = JSON.parse(secondOutput) as RaceCapability;
      capability = first;

      assert.deepEqual(second, first);
      assert.equal(first.baseUrl, "http://race.test");
      assert.ok(Date.now() - startedAt > 600);
      assert.deepEqual(
        readFileSync(attemptsPath, "utf8").trim().split("\n").sort(),
        ["loser", "winner"]
      );
      completed = true;
    } finally {
      const pid = capability?.pid ?? cleanupPid(capabilityPath, lockPath);
      if (pid !== undefined) await stopProcess(pid);
      if (completed) {
        assert.equal(existsSync(capabilityPath), false);
        assert.equal(existsSync(lockPath), false);
      }
      rmSync(raceRoot, { recursive: true, force: true });
    }
  });

  it("fails promptly when the child exits cleanly without a capability", async () => {
    const startedAt = Date.now();
    const child = fakeChild();
    const pending = ensureCmdProtoServer<Capability>({
      readCapability: () => undefined,
      pollMs: 1,
      timeoutMs: 4_000,
      spawn: spawnStub(() => {
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      })
    });

    await assert.rejects(pending, daemonUnavailable(/\(0\)/));
    assert.ok(Date.now() - startedAt < 2_000);
  });

  it("fails promptly on an unambiguous spawn error", async () => {
    const startedAt = Date.now();
    const child = fakeChild();
    const pending = ensureCmdProtoServer<Capability>({
      readCapability: () => undefined,
      pollMs: 1,
      timeoutMs: 4_000,
      spawn: spawnStub(() => {
        queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
        return child;
      })
    });

    await assert.rejects(pending, daemonUnavailable(/spawn ENOENT/));
    assert.ok(Date.now() - startedAt < 1_000);
  });
});

describe("createCmdProtoInternalServer", () => {
  it("runs a start-only lifecycle without unused Connect options", async () => {
    const runtime = createGreeterRuntime();
    let startedRuntime: CmdProtoRuntime | undefined;
    const internal = createCmdProtoInternalServer({
      start(candidate) {
        startedRuntime = candidate;
        return { closed: Promise.resolve() };
      }
    });

    await internal.run(runtime);
    assert.equal(startedRuntime, runtime);
  });

  it("runs a mount-only lifecycle with the package-created handler", async () => {
    const runtime = createGreeterRuntime();
    let mountedRuntime: CmdProtoRuntime | undefined;
    const internal = createCmdProtoInternalServer({
      allowMethods: [GREETER_METHOD],
      authorize: () => true,
      mount(handler, candidate) {
        assert.equal(typeof handler, "function");
        mountedRuntime = candidate;
        return { closed: Promise.resolve() };
      }
    });

    await internal.run(runtime);
    assert.equal(mountedRuntime, runtime);
  });

  it("rejects missing or conflicting callbacks at runtime", () => {
    assert.throws(
      () => createCmdProtoInternalServer({} as CmdProtoInternalServerOptions),
      /exactly one start or mount callback/
    );
    assert.throws(
      () => createCmdProtoInternalServer({
        start: () => ({}),
        mount: () => ({}),
        allowMethods: [],
        authorize: () => true
      } as unknown as CmdProtoInternalServerOptions),
      /exactly one start or mount callback/
    );
  });
});

if (false) {
  createCmdProtoInternalServer({ start: () => ({}) });
  createCmdProtoInternalServer({
    mount: () => ({}),
    allowMethods: [],
    authorize: () => true
  });
  // @ts-expect-error start and mount are mutually exclusive.
  createCmdProtoInternalServer({ start: () => ({}), mount: () => ({}), allowMethods: [], authorize: () => true });
  // @ts-expect-error one lifecycle callback is required.
  createCmdProtoInternalServer({ allowMethods: [], authorize: () => true });
}

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { unref(): void {} });
}

function spawnStub(factory: () => FakeChild): typeof spawn {
  return (() => factory()) as unknown as typeof spawn;
}

function daemonUnavailable(message: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof CmdProtoError);
    assert.equal(error.code, "DAEMON_UNAVAILABLE");
    assert.match(error.message, message);
    return true;
  };
}

function runIsolatedCaller(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      RACE_CALLER_PATH
    ], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`isolated caller failed (${code ?? signal ?? "unknown"}): ${stderr}`));
      }
    });
  });
}

function cleanupPid(capabilityPath: string, lockPath: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(capabilityPath, "utf8")) as RaceCapability).pid;
  } catch {
    try {
      const pid = Number(readFileSync(lockPath, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!processExists(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (processExists(pid)) {
    process.kill(pid, "SIGKILL");
    throw new Error(`isolated race server ${pid} did not stop after SIGTERM`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
