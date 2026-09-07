import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCmdProtoConnectTransport } from "cmdproto/connect";
import { ensureCmdProtoServer, type CmdProtoServerCapability } from "cmdproto/connect/bootstrap";
import { createRuntimeFromFile, runCli } from "cmdproto";
import { handlers, MANIFEST_PATH, METHOD_NAME, SCHEMA_PATH } from "./app.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const capabilityPath = requiredCapabilityPath();

interface DemoCapability extends CmdProtoServerCapability {
  readonly baseUrl: string;
  readonly pid: number;
}

export async function ensureDemoServer(): Promise<DemoCapability> {
  return ensureCmdProtoServer<DemoCapability>({
    lockKey: capabilityPath,
    readCapability: async () => {
      try { return JSON.parse(await readFile(capabilityPath, "utf8")) as DemoCapability; }
      catch { return undefined; }
    },
    isUsable: (capability) => (
      typeof capability.baseUrl === "string"
      && Number.isSafeInteger(capability.pid)
      && capability.pid > 0
    ),
    executable: process.execPath,
    args: ["--import", "tsx", join(ROOT, "app.ts")]
  });
}

async function stopDemoServer(capability: DemoCapability): Promise<void> {
  try {
    process.kill(capability.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processExists(capability.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (processExists(capability.pid)) {
    process.kill(capability.pid, "SIGKILL");
    throw new Error(`demo server ${capability.pid} did not stop after SIGTERM`);
  }
  await rm(capabilityPath, { force: true });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function requiredCapabilityPath(): string {
  const value = process.env.CMDPROTO_CAPABILITY_PATH;
  if (!value) throw new Error("CMDPROTO_CAPABILITY_PATH is required");
  return value;
}

if (process.argv[1] && process.argv[1].endsWith("client.mts")) {
  let capability: DemoCapability | undefined;
  try {
    capability = await ensureDemoServer();
    const runtime = createRuntimeFromFile(handlers, SCHEMA_PATH, MANIFEST_PATH);
    const transport = createCmdProtoConnectTransport({
      remoteMethods: [METHOD_NAME],
      baseUrl: capability.baseUrl
    });
    const result = await runCli(runtime, ["ping", "Ada"], "", transport);
    process.stdout.write(result.stdout);
  } finally {
    if (capability) await stopDemoServer(capability);
  }
}
