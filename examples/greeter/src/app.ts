import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeFromFile,
  runMain,
  type HandlerMap
} from "../../../runtimes/runtime.js";

export const GREETER_METHOD = "greeter.v1.GreeterService.SayHello";
export const GREETER_CARD_METHOD = "greeter.v1.GreeterService.RenderCard";
export const GREETER_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/schema.binpb"
);
export const GREETER_MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/runtime.binpb"
);

export const handlers: HandlerMap = {
  [GREETER_METHOD](params) {
    const name = String(params.name ?? "");
    const message = `Hello, ${name}!`;
    return {
      message: params.shout ? message.toUpperCase() : message
    };
  },
  [GREETER_CARD_METHOD](params) {
    const payload =
      params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
        ? (params.payload as Record<string, unknown>)
        : {};
    const name = String(payload.name ?? "");
    const prefix = String(params.prefix ?? "");
    const message = `${prefix}: Hello, ${name}!`;
    return {
      message: payload.shout ? message.toUpperCase() : message
    };
  }
};

export function createGreeterRuntime(
  schemaPath = GREETER_SCHEMA_PATH,
  manifestPath = GREETER_MANIFEST_PATH
) {
  return createRuntimeFromFile(handlers, schemaPath, manifestPath);
}

if (process.argv[1] && process.argv[1].endsWith("app.ts")) {
  await runMain({
    handlers,
    schemaPath: GREETER_SCHEMA_PATH,
    manifestPath: GREETER_MANIFEST_PATH
  });
}
