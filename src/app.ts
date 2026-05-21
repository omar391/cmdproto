import { join } from "node:path";
import { runCli } from "./cli.js";
import { CmdProtoRuntime, createRuntime } from "./runtime.js";
import { loadSchemaFromFile } from "./schema.js";
import type { CliResult, HandlerMap } from "./types.js";

export interface AppOptions {
  handlers: HandlerMap;
  schemaPath?: string;
}

export interface RunMainOptions extends AppOptions {
  argv?: string[];
  stdin?: string;
}

export function getDefaultSchemaPath(cwd = process.cwd()): string {
  return join(cwd, "dist/schema.binpb");
}

export function createRuntimeFromFile(
  handlers: HandlerMap,
  schemaPath = getDefaultSchemaPath()
): CmdProtoRuntime {
  const schema = loadSchemaFromFile(schemaPath);
  return createRuntime(schema, handlers);
}

export async function executeApp({
  handlers,
  schemaPath = getDefaultSchemaPath(),
  argv = process.argv.slice(2),
  stdin = ""
}: RunMainOptions): Promise<CliResult> {
  const runtime = createRuntimeFromFile(handlers, schemaPath);
  return runCli(runtime, argv, stdin);
}

export async function runMain(options: RunMainOptions): Promise<CliResult> {
  const result = await executeApp(options);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.statusCode;
  return result;
}
