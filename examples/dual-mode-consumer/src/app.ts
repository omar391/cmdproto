import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCmdProtoInternalServer } from "cmdproto/connect/bootstrap";
import { createRuntimeFromFile, isCmdProtoInternalServerInvocation, runMain, type HandlerMap } from "cmdproto";

export const METHOD_NAME = "demo.v1.DemoService.Ping";
const ROOT = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(ROOT, "../dist/schema.binpb");
export const MANIFEST_PATH = join(ROOT, "../dist/runtime.binpb");

export const handlers: HandlerMap = {
  [METHOD_NAME](params) {
    return { message: `Hello, ${String(params.name ?? "")}!` };
  }
};

export function createRuntime() {
  return createRuntimeFromFile(handlers, SCHEMA_PATH, MANIFEST_PATH);
}

function capabilityPath(): string {
  const value = process.env.CMDPROTO_CAPABILITY_PATH;
  if (!value) throw new Error("CMDPROTO_CAPABILITY_PATH is required in internal mode");
  return value;
}

function mount(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void) {
  const server = createServer(handler);
  let rejectClosed: (error: Error) => void = () => {};
  const closed = new Promise<void>((resolve, reject) => {
    rejectClosed = reject;
    server.once("close", () => {
      void rm(capabilityPath(), { force: true }).then(() => resolve(), reject);
    });
    server.once("error", reject);
  });
  const close = (): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const shutdown = (): void => {
    void close().catch(rejectClosed);
  };
  process.once("SIGTERM", shutdown);
  server.listen(0, "127.0.0.1", async () => {
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("demo server did not publish an address");
      const path = capabilityPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        pid: process.pid
      }), { mode: 0o600 });
    } catch (error) {
      rejectClosed(error instanceof Error ? error : new Error(String(error)));
      await close();
    }
  });
  return {
    closed,
    close
  };
}

if (process.argv[1] && process.argv[1].endsWith("app.ts")) {
  const internal = isCmdProtoInternalServerInvocation();
  await runMain({
    handlers,
    schemaPath: SCHEMA_PATH,
    manifestPath: MANIFEST_PATH,
    ...(internal ? {
      internalServer: createCmdProtoInternalServer({
        allowMethods: [METHOD_NAME],
        authorize: () => true,
        mount
      })
    } : {})
  });
}
