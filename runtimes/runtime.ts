import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFileRegistry,
  fromBinary,
  fromJson,
  getOption,
  hasOption,
  ScalarType,
  toJson,
  type DescExtension,
  type DescField,
  type DescMessage,
  type DescMethod,
  type FileRegistry,
  type JsonObject as BufJsonObject,
  type JsonValue
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

export type JsonObject = BufJsonObject;

export interface CliExample {
  command: string;
  description: string;
  requestJson: string;
}

export interface CommandOptions {
  path: string;
  summary: string;
  alias: string[];
  example: CliExample[];
  hidden: boolean;
  deprecated: boolean;
}

export interface PositionalOptions {
  index: number;
}

export interface FlagOptions {
  long: string;
  short: string;
}

export interface ParamOptions {
  positional?: PositionalOptions;
  flag?: FlagOptions;
  help: string;
  hidden: boolean;
}

export interface FieldSpec {
  name: string;
  jsonName: string;
  localName: string;
  descriptor: DescField;
  param: ParamOptions;
}

export interface MethodSpec {
  name: string;
  serviceName: string;
  rpcName: string;
  input: DescMessage;
  output: DescMessage;
  descriptor: DescMethod;
  command: CommandOptions;
  fields: FieldSpec[];
}

export interface CmdProtoSchema {
  registry: FileRegistry;
  methods: MethodSpec[];
  methodByName: Map<string, MethodSpec>;
}

export interface CommandRequestJson {
  method: string;
  params?: JsonValue;
  requestId?: string;
}

export interface CommandErrorJson {
  code: string;
  message: string;
  details?: JsonValue;
}

export type CommandResponseJson =
  | {
      ok: true;
      result: JsonValue;
      requestId?: string;
    }
  | {
      ok: false;
      error: CommandErrorJson;
      requestId?: string;
    };

export interface HandlerContext {
  method: MethodSpec;
  request: CommandRequestJson;
}

export type CmdProtoHandler = (
  params: JsonObject,
  context: HandlerContext
) => JsonValue | Promise<JsonValue>;

export type HandlerMap = Record<string, CmdProtoHandler>;

export interface CliResult {
  statusCode: number;
  stdout: string;
  stderr: string;
}

export interface AppOptions {
  handlers: HandlerMap;
  schemaPath?: string;
}

export interface RunMainOptions extends AppOptions {
  argv?: string[];
  stdin?: string;
}

const COMMAND_OPTION = "cmdproto.v1.command";
const PARAM_OPTION = "cmdproto.v1.param";
const REQUEST_KEYS = new Set(["method", "params", "requestId"]);
const COMMAND_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LONG_FLAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHORT_FLAG_RE = /^[A-Za-z0-9]$/;
const RESERVED_COMMAND_ROOTS = new Set(["cmdproto"]);
const RESERVED_LONG_FLAGS = new Set(["help", "json", "verbose"]);
const RESERVED_SHORT_FLAGS = new Set(["h"]);
const HELP_FLAG = "--help";
const JSON_FLAG = "--json";
const VERBOSE_FLAG = "--verbose";
const EXECUTE_USAGE = "cmdproto execute --json '<request>'";
const EXECUTE_SUMMARY = "Execute a machine request envelope.";

interface CommandBinding {
  key: string;
  tokens: string[];
  method: MethodSpec;
  source: string;
  positionalCount: number;
}

export class CmdProtoError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = "CmdProtoError";
    this.code = code;
    this.details = details;
  }
}

export function loadSchemaFromFile(path: string): CmdProtoSchema {
  return loadSchemaFromBinary(readFileSync(path));
}

export function loadSchemaFromBinary(bytes: Uint8Array): CmdProtoSchema {
  const fileDescriptorSet = fromBinary(FileDescriptorSetSchema, bytes);
  const registry = createFileRegistry(fileDescriptorSet);
  const commandOption = requireExtension(registry.getExtension(COMMAND_OPTION), COMMAND_OPTION);
  const paramOption = requireExtension(registry.getExtension(PARAM_OPTION), PARAM_OPTION);
  const methods = discoverMethods(commandOption, paramOption, registry);
  validateMethodSpecs(methods, registry);

  return {
    registry,
    methods,
    methodByName: new Map(methods.map((method) => [method.name, method]))
  };
}

function requireExtension(
  extension: DescExtension | undefined,
  typeName: string
): DescExtension {
  if (!extension) {
    throw new Error(`Descriptor set does not include ${typeName}`);
  }
  return extension;
}

function discoverMethods(
  commandOption: DescExtension,
  paramOption: DescExtension,
  registry: FileRegistry
): MethodSpec[] {
  const methods: MethodSpec[] = [];

  for (const descriptor of registry) {
    if (descriptor.kind !== "service") {
      continue;
    }

    for (const method of descriptor.methods) {
      if (!hasOption(method, commandOption)) {
        continue;
      }

      const command = normalizeCommandOptions(
        getOption(method, commandOption) as CommandOptions
      );
      if (!command.path) {
        throw new Error(`${descriptor.typeName}.${method.name} is missing cmdproto command path`);
      }

      methods.push({
        name: `${descriptor.typeName}.${method.name}`,
        serviceName: descriptor.typeName,
        rpcName: method.name,
        input: method.input,
        output: method.output,
        descriptor: method,
        command,
        fields: discoverFields(method, paramOption)
      });
    }
  }

  return methods.sort((left, right) => left.name.localeCompare(right.name));
}

function discoverFields(method: DescMethod, paramOption: DescExtension): FieldSpec[] {
  return method.input.fields.map((field) => ({
    name: field.name,
    jsonName: field.jsonName,
    localName: field.localName,
    descriptor: field,
    param: hasOption(field, paramOption)
      ? normalizeParamOptions(getOption(field, paramOption) as ParamOptions)
      : normalizeParamOptions()
  }));
}

function normalizeCommandOptions(value?: Partial<CommandOptions>): CommandOptions {
  return {
    path: value?.path ?? "",
    summary: value?.summary ?? "",
    alias: [...(value?.alias ?? [])],
    example: [...(value?.example ?? [])].map((example) => ({
      command: example.command ?? "",
      description: example.description ?? "",
      requestJson: example.requestJson ?? ""
    })),
    hidden: value?.hidden ?? false,
    deprecated: value?.deprecated ?? false
  };
}

function normalizeParamOptions(value?: Partial<ParamOptions>): ParamOptions {
  const positional = normalizePositional(value?.positional);
  const flag = normalizeFlag(value?.flag);

  return {
    ...(positional ? { positional } : {}),
    ...(flag ? { flag } : {}),
    help: value?.help ?? "",
    hidden: value?.hidden ?? false
  };
}

function normalizePositional(
  value?: Partial<PositionalOptions>
): PositionalOptions | undefined {
  if (!value?.index) {
    return undefined;
  }
  return { index: value.index };
}

function normalizeFlag(value?: Partial<FlagOptions>): FlagOptions | undefined {
  const long = value?.long ?? "";
  const short = value?.short ?? "";

  if (!long && !short) {
    return undefined;
  }
  return { long, short };
}

export function getFieldSpec(method: MethodSpec, field: DescField): FieldSpec {
  const spec = method.fields.find((candidate) => candidate.descriptor === field);
  if (!spec) {
    throw new Error(`Field ${field.name} is not part of ${method.name}`);
  }
  return spec;
}

export function splitCommandPath(path: string): string[] {
  return path.trim().split(/\s+/).filter(Boolean);
}

export function normalizeCommandPath(path: string): string {
  return splitCommandPath(path).join(" ");
}

export function validateMethodSpecs(methods: MethodSpec[], registry?: FileRegistry): void {
  const bindings: CommandBinding[] = [];
  const seenCommands = new Map<string, CommandBinding>();

  for (const method of methods) {
    const positionalCount = validateMethodFields(method);
    validateMethodExamples(method, registry);
    for (const binding of collectCommandBindings(method, positionalCount)) {
      const existing = seenCommands.get(binding.key);
      if (existing) {
        throw new Error(
          `Duplicate command path "${binding.key}" for ${binding.method.name}; already used by ${existing.method.name}`
        );
      }
      seenCommands.set(binding.key, binding);
      bindings.push(binding);
    }
  }

  for (let index = 0; index < bindings.length; index += 1) {
    const current = bindings[index];
    if (!current) {
      continue;
    }
    for (let candidateIndex = index + 1; candidateIndex < bindings.length; candidateIndex += 1) {
      const candidate = bindings[candidateIndex];
      if (!candidate) {
        continue;
      }
      validatePrefixShadowing(current, candidate);
      validatePrefixShadowing(candidate, current);
    }
  }
}

function validateMethodExamples(method: MethodSpec, registry?: FileRegistry): void {
  if (method.command.example.length === 0) {
    throw new Error(`${method.name} must declare at least one cmdproto example`);
  }

  for (const example of method.command.example) {
    const command = example.command.trim();
    if (!command) {
      throw new Error(`${method.name} has a cmdproto example with an empty command`);
    }

    const requestJson = example.requestJson.trim();
    if (!requestJson) {
      throw new Error(`${method.name} example "${command}" is missing request_json`);
    }

    if (!registry) {
      continue;
    }

    const commandParams = validateExampleCommand(method, command, registry);
    const requestParams = validateExampleRequestJson(method, requestJson, registry);
    if (JSON.stringify(commandParams) !== JSON.stringify(requestParams)) {
      throw new Error(
        `${method.name} example "${command}" does not match request_json params`
      );
    }
  }
}

function validateExampleCommand(
  method: MethodSpec,
  command: string,
  registry: FileRegistry
): JsonObject {
  const tokens = splitCommandPath(command);
  const match = findCommandMatchForMethod(method, tokens);
  if (!match) {
    throw new Error(
      `${method.name} example "${command}" must start with the command path or an alias`
    );
  }

  const params = parseArguments(method, tokens.slice(match.tokens.length));
  return canonicalizeJsonMessage(method.input, params, registry) as JsonObject;
}

function validateExampleRequestJson(
  method: MethodSpec,
  rawRequest: string,
  registry: FileRegistry
): JsonObject {
  const request = normalizeRequest(parseJsonRequest(rawRequest));
  if (request.method !== method.name) {
    throw new Error(
      `${method.name} example request_json must use method "${method.name}"`
    );
  }
  return canonicalizeJsonMessage(method.input, request.params ?? {}, registry) as JsonObject;
}

export function renderMethodUsage(method: MethodSpec): string {
  const parts = [normalizeCommandPath(method.command.path)];

  for (const field of getPositionalFields(method)) {
    parts.push(`<${renderPlaceholder(field.name)}>`);
  }

  for (const field of getFlagFields(method)) {
    const flag = field.param.flag;
    if (!flag) {
      continue;
    }
    const names = [];
    if (flag.short) {
      names.push(`-${flag.short}`);
    }
    if (flag.long) {
      names.push(`--${flag.long}`);
    }
    parts.push(`[${names.join(", ")}]`);
  }

  return parts.join(" ");
}

function collectCommandBindings(method: MethodSpec, positionalCount: number): CommandBinding[] {
  const bindings: CommandBinding[] = [];

  for (const [label, rawPath] of [
    ["path", method.command.path],
    ...method.command.alias.map((alias) => ["alias", alias] as const)
  ]) {
    const key = validateCommandPath(method, rawPath, label);
    bindings.push({
      key,
      tokens: splitCommandPath(key),
      method,
      source: `${label} "${key}"`,
      positionalCount
    });
  }

  return bindings;
}

function validateCommandPath(method: MethodSpec, path: string, label: string): string {
  const normalized = normalizeCommandPath(path);
  const tokens = splitCommandPath(normalized);

  if (tokens.length === 0) {
    throw new Error(`${method.name} is missing cmdproto ${label}`);
  }
  if (RESERVED_COMMAND_ROOTS.has(tokens[0] ?? "")) {
    throw new Error(
      `${method.name} uses reserved command root "${tokens[0]}" in ${label} "${normalized}"`
    );
  }
  for (const token of tokens) {
    if (!COMMAND_TOKEN_RE.test(token)) {
      throw new Error(
        `${method.name} has invalid command token "${token}" in ${label} "${normalized}"`
      );
    }
  }

  return normalized;
}

function validateMethodFields(method: MethodSpec): number {
  const seenFlags = new Map<string, string>();
  const seenPositionals = new Map<number, string>();

  for (const field of method.fields) {
    const positional = field.param.positional?.index;
    const flag = field.param.flag;

    if (positional && flag) {
      throw new Error(
        `${method.name}.${field.name} cannot be both positional and flag-bound in cmdproto`
      );
    }

    if (positional) {
      if (!supportsPositional(field.descriptor)) {
        throw new Error(
          `${method.name}.${field.name} must be scalar or enum to be positional in cmdproto`
        );
      }
      if (seenPositionals.has(positional)) {
        throw new Error(
          `${method.name} reuses positional index ${positional} for ${field.name} and ${seenPositionals.get(positional)}`
        );
      }
      seenPositionals.set(positional, field.name);
    }

    if (flag) {
      if (!supportsFlag(field.descriptor)) {
        throw new Error(
          `${method.name}.${field.name} must be scalar, enum, or repeated scalar/enum to be a flag in cmdproto`
        );
      }
      registerFlag(seenFlags, method, field, "long", flag.long);
      registerFlag(seenFlags, method, field, "short", flag.short);
    }
  }

  const indices = [...seenPositionals.keys()].sort((left, right) => left - right);
  for (let expected = 1; expected <= indices.length; expected += 1) {
    if (indices[expected - 1] !== expected) {
      throw new Error(
        `${method.name} must use contiguous positional indexes starting at 1; missing ${expected}`
      );
    }
  }

  return indices.length;
}

function registerFlag(
  seenFlags: Map<string, string>,
  method: MethodSpec,
  field: FieldSpec,
  kind: "long" | "short",
  rawValue: string
): void {
  const value = rawValue.trim();
  if (!value) {
    return;
  }

  if (kind === "long") {
    if (!LONG_FLAG_RE.test(value)) {
      throw new Error(`${method.name}.${field.name} has invalid long flag "${value}"`);
    }
    if (RESERVED_LONG_FLAGS.has(value)) {
      throw new Error(`${method.name}.${field.name} uses reserved long flag "--${value}"`);
    }
  } else {
    if (!SHORT_FLAG_RE.test(value)) {
      throw new Error(`${method.name}.${field.name} has invalid short flag "${value}"`);
    }
    if (RESERVED_SHORT_FLAGS.has(value)) {
      throw new Error(`${method.name}.${field.name} uses reserved short flag "-${value}"`);
    }
  }

  const key = `${kind}:${value}`;
  const existing = seenFlags.get(key);
  if (existing) {
    throw new Error(
      `${method.name} reuses ${kind} flag "${value}" for ${field.name} and ${existing}`
    );
  }
  seenFlags.set(key, field.name);
}

function validatePrefixShadowing(shorter: CommandBinding, longer: CommandBinding): void {
  if (shorter.positionalCount === 0) {
    return;
  }
  if (shorter.tokens.length >= longer.tokens.length) {
    return;
  }
  if (!isPrefix(shorter.tokens, longer.tokens)) {
    return;
  }

  throw new Error(
    `${shorter.method.name} ${shorter.source} is a prefix of ${longer.method.name} ${longer.source}; commands with positional arguments cannot shadow longer command paths`
  );
}

function isPrefix(prefix: string[], tokens: string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function supportsPositional(field: DescField): boolean {
  return field.fieldKind === "scalar" || field.fieldKind === "enum";
}

function supportsFlag(field: DescField): boolean {
  if (field.fieldKind === "scalar" || field.fieldKind === "enum") {
    return true;
  }
  return (
    field.fieldKind === "list" &&
    (field.listKind === "scalar" || field.listKind === "enum")
  );
}

function renderPlaceholder(fieldName: string): string {
  return fieldName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function getPositionalFields(method: MethodSpec): FieldSpec[] {
  return method.fields
    .filter((field) => field.param.positional && !field.param.hidden)
    .sort(
      (left, right) =>
        (left.param.positional?.index ?? Number.MAX_SAFE_INTEGER) -
        (right.param.positional?.index ?? Number.MAX_SAFE_INTEGER)
    );
}

function getFlagFields(method: MethodSpec): FieldSpec[] {
  return method.fields
    .filter((field) => field.param.flag && !field.param.hidden)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export class CmdProtoRuntime {
  readonly schema: CmdProtoSchema;
  readonly handlers: HandlerMap;

  constructor(schema: CmdProtoSchema, handlers: HandlerMap) {
    this.schema = schema;
    this.handlers = handlers;
  }

  async dispatch(input: unknown): Promise<CommandResponseJson> {
    let request: CommandRequestJson;
    try {
      request = normalizeRequest(input);
    } catch (error) {
      return errorResponse(error);
    }

    const method = this.schema.methodByName.get(request.method);
    if (!method) {
      return errorResponse(
        new CmdProtoError("METHOD_NOT_FOUND", `Unknown method: ${request.method}`),
        request.requestId
      );
    }

    const handler = this.handlers[method.name];
    if (!handler) {
      return errorResponse(
        new CmdProtoError("HANDLER_NOT_FOUND", `No handler registered for ${method.name}`),
        request.requestId
      );
    }

    try {
      const params = validateParams(this.schema, method, request.params ?? {});
      const context: HandlerContext = {
        method,
        request
      };
      const rawResult = await handler(params, context);
      const result = validateResult(this.schema, method, rawResult);
      return withRequestId({ ok: true, result }, request.requestId);
    } catch (error) {
      return errorResponse(error, request.requestId);
    }
  }
}

export function createRuntime(
  schema: CmdProtoSchema,
  handlers: HandlerMap
): CmdProtoRuntime {
  return new CmdProtoRuntime(schema, handlers);
}

export function normalizeRequest(input: unknown): CommandRequestJson {
  if (!isPlainObject(input)) {
    throw new CmdProtoError("INVALID_REQUEST", "Request must be a JSON object");
  }

  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new CmdProtoError("INVALID_REQUEST", `Unknown request field: ${key}`);
    }
  }

  if (typeof input.method !== "string" || input.method.length === 0) {
    throw new CmdProtoError("INVALID_REQUEST", "Request field method must be a non-empty string");
  }
  if ("requestId" in input && typeof input.requestId !== "string") {
    throw new CmdProtoError("INVALID_REQUEST", "Request field requestId must be a string");
  }
  const requestId = ("requestId" in input ? input.requestId : undefined) as
    | string
    | undefined;

  return {
    method: input.method,
    params: (input.params ?? {}) as JsonValue,
    requestId
  };
}

function validateParams(
  schema: CmdProtoSchema,
  method: MethodSpec,
  params: JsonValue
): JsonObject {
  try {
    return canonicalizeJsonMessage(method.input, params, schema.registry) as JsonObject;
  } catch (error) {
    throw new CmdProtoError("INVALID_ARGUMENT", formatError(error));
  }
}

function validateResult(
  schema: CmdProtoSchema,
  method: MethodSpec,
  result: JsonValue
): JsonValue {
  try {
    return canonicalizeJsonMessage(method.output, result ?? {}, schema.registry);
  } catch (error) {
    throw new CmdProtoError("INVALID_RESULT", formatError(error));
  }
}

function canonicalizeJsonMessage(
  message: DescMessage,
  value: JsonValue,
  registry: FileRegistry
): JsonValue {
  const parsed = fromJson(message, value, {
    ignoreUnknownFields: false,
    registry
  });
  return toJson(message, parsed, { registry }) as JsonValue;
}

function errorResponse(
  error: unknown,
  requestId?: string
): CommandResponseJson {
  const normalized =
    error instanceof CmdProtoError
      ? error
      : new CmdProtoError("INTERNAL", formatError(error));

  return withRequestId(
    {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined ? {} : { details: normalized.details })
      }
    },
    requestId
  );
}

function withRequestId<T extends CommandResponseJson>(
  response: T,
  requestId: string | undefined
): T {
  if (!requestId) {
    return response;
  }
  return { ...response, requestId };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // The app runtime stays transport-neutral. Today `runCli()` is the one-shot
  // stdio adapter; future HTTP and streaming adapters should sit beside it.
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

export async function runCli(
  runtime: CmdProtoRuntime,
  argv: string[],
  stdin = ""
): Promise<CliResult> {
  try {
    const helpResult = runHelpCommand(runtime.schema, argv);
    if (helpResult) {
      return helpResult;
    }

    const controlResult = await runCmdprotoCommand(runtime, argv, stdin);
    if (controlResult) {
      return controlResult;
    }

    const request = parseHumanCommand(runtime.schema, argv);
    const response = await runtime.dispatch(request);
    return jsonEnvelopeResult(response, response.ok ? 0 : 1);
  } catch (error) {
    return jsonEnvelopeResult(
      {
        ok: false,
        error:
          error instanceof CmdProtoError
            ? { code: error.code, message: error.message }
            : { code: "INTERNAL", message: formatError(error) }
      },
      1
    );
  }
}

export function parseHumanCommand(
  schema: CmdProtoSchema,
  argv: string[]
): CommandRequestJson {
  const match = findCommand(schema.methods, argv);
  if (!match) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${argv.join(" ")}`);
  }

  const params = parseArguments(match.method, argv.slice(match.tokens.length));
  return {
    method: match.method.name,
    params
  };
}

export function renderHelp(schema: CmdProtoSchema): string {
  const lines = ["Application commands:", ""];
  for (const method of schema.methods.filter((candidate) => !candidate.command.hidden)) {
    lines.push(`  ${renderMethodUsage(method).padEnd(28)} ${method.command.summary}`.trimEnd());
  }
  lines.push(
    "",
    "Command help:",
    "  <command> --help",
    "  <command> --help --json",
    "  <command> --help --json --verbose",
    "",
    "Machine control:",
    `  ${EXECUTE_USAGE.padEnd(36)} ${EXECUTE_SUMMARY}`.trimEnd()
  );
  return `${lines.join("\n")}\n`;
}

async function runCmdprotoCommand(
  runtime: CmdProtoRuntime,
  argv: string[],
  stdin: string
): Promise<CliResult | undefined> {
  // This is the one-shot stdio control surface. If we later add live streams,
  // they should come from a persistent transport mode instead of this command.
  if (argv[0] !== "cmdproto") {
    return undefined;
  }

  if (argv[1] === "execute") {
    if (argv[2] !== "--json" || argv.length > 4) {
      throw new CmdProtoError(
        "INVALID_ARGUMENT",
        `Usage: ${EXECUTE_USAGE}`
      );
    }
    const request = parseJsonRequest(argv[3] ?? stdin);
    const response = await runtime.dispatch(request);
    return jsonEnvelopeResult(response, response.ok ? 0 : 1);
  }

  throw new CmdProtoError(
    "INVALID_ARGUMENT",
    `Unknown cmdproto command: ${argv.slice(1).join(" ")}`
  );
}

function runHelpCommand(schema: CmdProtoSchema, argv: string[]): CliResult | undefined {
  if (argv.length === 0) {
    return textResult(renderHelp(schema));
  }

  const helpRequested = argv.includes(HELP_FLAG);
  if (!helpRequested && !(argv[0] === "cmdproto" && argv.length === 1)) {
    return undefined;
  }

  const json = helpRequested && argv.includes(JSON_FLAG);
  const verbose = json && argv.includes(VERBOSE_FLAG);
  const filtered = helpRequested
    ? argv.filter((token) => token !== HELP_FLAG && token !== JSON_FLAG && token !== VERBOSE_FLAG)
    : argv;

  if (filtered.length === 0) {
    return json
      ? renderJsonHelp(
          verbose ? buildVerboseGlobalHelpJson(schema) : buildMinimalGlobalHelpJson(schema),
          verbose
        )
      : textResult(renderHelp(schema));
  }

  if (filtered[0] === "cmdproto") {
    return renderCmdprotoHelp(filtered.slice(1), json, verbose);
  }

  const match = findCommand(schema.methods, filtered);
  if (!match) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${filtered.join(" ")}`);
  }

  return json
    ? renderJsonHelp(
        verbose
          ? buildVerboseMethodHelpJson(match.method)
          : buildMinimalMethodHelpJson(match.method),
        verbose
      )
    : textResult(renderMethodHelp(match.method));
}

function renderCmdprotoHelp(argv: string[], json: boolean, verbose: boolean): CliResult {
  if (argv.length === 0) {
    return json
      ? renderJsonHelp(
          verbose ? buildVerboseCmdprotoIndexJson() : buildMinimalCmdprotoIndexJson(),
          verbose
        )
      : textResult(renderCmdprotoIndexHelp());
  }

  if (argv.length === 1 && argv[0] === "execute") {
    return json
      ? renderJsonHelp(
          verbose ? buildVerboseExecuteHelpJson() : buildMinimalExecuteHelpJson(),
          verbose
        )
      : textResult(renderExecuteHelp());
  }

  throw new CmdProtoError(
    "INVALID_ARGUMENT",
    `Unknown cmdproto command: ${argv.join(" ")}`
  );
}

function buildMinimalGlobalHelpJson(schema: CmdProtoSchema): JsonObject {
  return {
    commands: schema.methods
      .filter((method) => !method.command.hidden)
      .map((method) => ({
        method: method.name,
        path: method.command.path,
        ...(method.command.summary ? { summary: method.command.summary } : {})
      })),
    cmdproto: [buildMinimalExecuteHelpJson()]
  };
}

function buildVerboseGlobalHelpJson(schema: CmdProtoSchema): JsonObject {
  return {
    kind: "application",
    commands: schema.methods
      .filter((method) => !method.command.hidden)
      .map((method) => buildVerboseMethodHelpJson(method)),
    machineControl: [buildExecuteHelpSummaryJson()]
  };
}

function buildMinimalMethodHelpJson(method: MethodSpec): JsonObject {
  return {
    method: method.name,
    fields: buildMinimalFieldsJson(method),
    examples: method.command.example.map((example) => ({
      cmd: example.command,
      json: parseJsonValue(example.requestJson)
    }))
  };
}

function buildVerboseMethodHelpJson(method: MethodSpec): JsonObject {
  return {
    kind: "command",
    method: method.name,
    service: method.serviceName,
    rpc: method.rpcName,
    path: method.command.path,
    usage: renderMethodUsage(method),
    aliases: method.command.alias,
    summary: method.command.summary,
    input: method.input.typeName,
    output: method.output.typeName,
    deprecated: method.command.deprecated || method.descriptor.deprecated,
    fields: method.fields
      .filter((field) => !field.param.hidden)
      .map((field) => ({
        name: field.name,
        jsonName: field.jsonName,
        ...(field.param.positional ? { positionalIndex: field.param.positional.index } : {}),
        ...(field.param.flag?.long ? { longFlag: field.param.flag.long } : {}),
        ...(field.param.flag?.short ? { shortFlag: field.param.flag.short } : {}),
        ...(field.param.help ? { help: field.param.help } : {})
      })),
    examples: method.command.example.map((example) => ({
      command: example.command,
      ...(example.description ? { description: example.description } : {}),
      json: parseJsonValue(example.requestJson)
    }))
  };
}

function buildMinimalFieldsJson(method: MethodSpec): JsonObject {
  return Object.fromEntries(
    method.fields
      .filter((field) => !field.param.hidden)
      .map((field) => [field.jsonName, buildMinimalFieldJson(field)])
  ) as JsonObject;
}

function buildMinimalFieldJson(field: FieldSpec): JsonObject {
  return {
    ...(field.name !== field.jsonName ? { name: field.name } : {}),
    ...(field.param.positional ? { positionalIndex: field.param.positional.index } : {}),
    ...(field.param.flag?.long ? { longFlag: field.param.flag.long } : {}),
    ...(field.param.flag?.short ? { shortFlag: field.param.flag.short } : {}),
    ...(field.param.help ? { help: field.param.help } : {})
  };
}

function buildMinimalCmdprotoIndexJson(): JsonObject {
  return {
    commands: [buildMinimalExecuteHelpJson()]
  };
}

function buildVerboseCmdprotoIndexJson(): JsonObject {
  return {
    kind: "control",
    commands: [buildExecuteHelpSummaryJson()]
  };
}

function buildExecuteHelpSummaryJson(): JsonObject {
  return {
    name: "cmdproto execute",
    usage: EXECUTE_USAGE,
    summary: EXECUTE_SUMMARY
  };
}

function buildMinimalExecuteHelpJson(): JsonObject {
  return buildExecuteHelpSummaryJson();
}

function buildVerboseExecuteHelpJson(): JsonObject {
  return {
    ...buildExecuteHelpSummaryJson(),
    request: {
      type: "object",
      additionalProperties: false,
      required: ["method"],
      properties: {
        method: {
          type: "string",
          description: "Fully-qualified RPC name."
        },
        params: {
          type: "object",
          description: "JSON input object for the RPC."
        },
        requestId: {
          type: "string",
          description: "Optional caller-provided correlation id."
        }
      }
    }
  };
}

function renderCmdprotoIndexHelp(): string {
  const lines = [
    "Machine control:",
    "",
    `  ${EXECUTE_USAGE.padEnd(36)} ${EXECUTE_SUMMARY}`.trimEnd()
  ];
  return `${lines.join("\n")}\n`;
}

function renderExecuteHelp(): string {
  const lines = [
    EXECUTE_SUMMARY,
    "",
    "Usage:",
    `  ${EXECUTE_USAGE}`,
    "",
    "Request fields:",
    "  method       Fully-qualified RPC name.",
    "  params       JSON input object for the RPC.",
    "  requestId    Optional caller-provided correlation id."
  ];
  return `${lines.join("\n")}\n`;
}

function renderMethodHelp(method: MethodSpec): string {
  const lines = [
    method.command.summary || method.name,
    "",
    "Usage:",
    `  ${renderMethodUsage(method)}`,
    "",
    "Machine method:",
    `  ${method.name}`
  ];

  if (method.command.alias.length > 0) {
    lines.push("", "Aliases:", `  ${method.command.alias.join(", ")}`);
  }

  lines.push("", "Parameters:");
  for (const field of getHelpFields(method)) {
    lines.push(`  ${renderFieldHelpLabel(field).padEnd(18)} ${field.param.help}`.trimEnd());
  }

  if (method.command.example.length > 0) {
    lines.push("", "Examples:");
    for (const example of method.command.example) {
      const detail = example.description ? ` ${example.description}` : "";
      lines.push(`  ${example.command}${detail}`);
      lines.push(`  ${example.requestJson}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function getHelpFields(method: MethodSpec): FieldSpec[] {
  const positionals = method.fields
    .filter((field) => field.param.positional && !field.param.hidden)
    .sort(
      (left, right) =>
        (left.param.positional?.index ?? Number.MAX_SAFE_INTEGER) -
        (right.param.positional?.index ?? Number.MAX_SAFE_INTEGER)
    );
  const flags = method.fields
    .filter((field) => field.param.flag && !field.param.hidden)
    .sort((left, right) => renderFieldHelpLabel(left).localeCompare(renderFieldHelpLabel(right)));

  return [...positionals, ...flags];
}

function renderFieldHelpLabel(field: FieldSpec): string {
  if (field.param.positional) {
    return `<${field.name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}>`;
  }
  const flag = field.param.flag;
  if (!flag) {
    return field.name;
  }

  const names = [];
  if (flag.short) {
    names.push(`-${flag.short}`);
  }
  if (flag.long) {
    names.push(`--${flag.long}`);
  }
  return names.join(", ");
}

function parseJsonRequest(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CmdProtoError("INVALID_REQUEST", "Missing JSON request");
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new CmdProtoError("INVALID_REQUEST", formatError(error));
  }
}

function parseJsonValue(raw: string): JsonValue {
  return parseJsonRequest(raw) as JsonValue;
}

function renderJsonHelp(value: JsonObject, verbose: boolean): CliResult {
  return verbose ? jsonEnvelopeResult({ ok: true, result: value }, 0) : jsonTextResult(value, 0);
}

function findCommand(
  methods: MethodSpec[],
  argv: string[]
): { method: MethodSpec; tokens: string[] } | undefined {
  const candidates: { method: MethodSpec; tokens: string[] }[] = [];

  for (const method of methods) {
    const match = findCommandMatchForMethod(method, argv);
    if (match) {
      candidates.push(match);
    }
  }

  candidates.sort((left, right) => right.tokens.length - left.tokens.length);
  return candidates[0];
}

function findCommandMatchForMethod(
  method: MethodSpec,
  argv: string[]
): { method: MethodSpec; tokens: string[] } | undefined {
  for (const command of [method.command.path, ...method.command.alias]) {
    const tokens = splitCommandPath(command);
    if (tokens.length > 0 && startsWith(argv, tokens)) {
      return { method, tokens };
    }
  }
  return undefined;
}

function startsWith(argv: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => argv[index] === token);
}

function parseArguments(method: MethodSpec, argv: string[]): JsonObject {
  const params: JsonObject = {};
  const positionals = method.fields
    .filter((field) => field.param.positional && !field.param.hidden)
    .sort(
      (left, right) =>
        (left.param.positional?.index ?? Number.MAX_SAFE_INTEGER) -
        (right.param.positional?.index ?? Number.MAX_SAFE_INTEGER)
    );
  const flags = buildFlagIndex(method.fields);
  let positionalIndex = 0;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && isFlagToken(token)) {
      const parsed = parseFlagToken(token);
      const field = flags.get(parsed.name);
      if (!field) {
        throw new CmdProtoError("INVALID_ARGUMENT", `Unknown flag: ${parsed.name}`);
      }

      const { value, consumedNext } = parseFlagValue(field, parsed.value, argv[index + 1]);
      setParam(params, field, value);
      if (consumedNext) {
        index += 1;
      }
      continue;
    }

    const field = positionals[positionalIndex];
    if (!field) {
      throw new CmdProtoError("INVALID_ARGUMENT", `Unexpected positional argument: ${token}`);
    }
    setParam(params, field, parseCliValue(field.descriptor, token));
    positionalIndex += 1;
  }

  for (const field of positionals) {
    if (!(field.jsonName in params)) {
      throw new CmdProtoError("INVALID_ARGUMENT", `Missing positional argument: ${field.name}`);
    }
  }

  return params;
}

function buildFlagIndex(fields: FieldSpec[]): Map<string, FieldSpec> {
  const flags = new Map<string, FieldSpec>();
  for (const field of fields) {
    if (field.param.hidden || !field.param.flag) {
      continue;
    }
    if (field.param.flag.long) {
      flags.set(`--${field.param.flag.long}`, field);
    }
    if (field.param.flag.short) {
      flags.set(`-${field.param.flag.short}`, field);
    }
  }
  return flags;
}

function isFlagToken(token: string): boolean {
  return (
    (token.startsWith("--") && token.length > 2) ||
    (token.startsWith("-") && token.length > 1)
  );
}

function parseFlagToken(token: string): { name: string; value?: string } {
  const equals = token.indexOf("=");
  if (equals === -1) {
    return { name: token };
  }
  return {
    name: token.slice(0, equals),
    value: token.slice(equals + 1)
  };
}

function parseFlagValue(
  field: FieldSpec,
  inlineValue: string | undefined,
  nextValue: string | undefined
): { value: JsonValue; consumedNext: boolean } {
  if (isBooleanField(field.descriptor)) {
    return {
      value: inlineValue === undefined ? true : parseBoolean(inlineValue),
      consumedNext: false
    };
  }

  const value = inlineValue ?? nextValue;
  if (value === undefined) {
    throw new CmdProtoError(
      "INVALID_ARGUMENT",
      `Flag ${renderPreferredFlag(field)} requires a value`
    );
  }
  return {
    value: parseCliValue(field.descriptor, value),
    consumedNext: inlineValue === undefined
  };
}

function setParam(params: JsonObject, field: FieldSpec, value: JsonValue): void {
  if (field.descriptor.fieldKind === "list") {
    const current = params[field.jsonName];
    params[field.jsonName] = Array.isArray(current) ? [...current, value] : [value];
    return;
  }
  params[field.jsonName] = value;
}

function parseCliValue(field: DescField, raw: string): JsonValue {
  if (field.fieldKind === "enum") {
    return raw;
  }
  if (field.fieldKind === "scalar") {
    return parseScalarValue(field.scalar, raw, field.name);
  }
  if (field.fieldKind === "list") {
    if (field.listKind === "enum") {
      return raw;
    }
    if (field.listKind === "scalar") {
      return parseScalarValue(field.scalar, raw, field.name);
    }
  }

  throw new CmdProtoError("INVALID_ARGUMENT", `Field ${field.name} is not CLI-scalar`);
}

function parseScalarValue(
  scalar: ScalarType,
  raw: string,
  fieldName: string
): JsonValue {
  switch (scalar) {
    case ScalarType.BOOL:
      return parseBoolean(raw);
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return parseNumber(raw, fieldName);
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return raw;
    case ScalarType.STRING:
      return raw;
    case ScalarType.BYTES:
      return raw;
    default:
      return raw;
  }
}

function renderPreferredFlag(field: FieldSpec): string {
  const flag = field.param.flag;
  if (!flag) {
    throw new CmdProtoError("INVALID_ARGUMENT", `Field ${field.name} is not flag-bound`);
  }
  if (flag.long) {
    return `--${flag.long}`;
  }
  return `-${flag.short}`;
}

function isBooleanField(field: DescField): boolean {
  return (
    (field.fieldKind === "scalar" && field.scalar === ScalarType.BOOL) ||
    (field.fieldKind === "list" &&
      field.listKind === "scalar" &&
      field.scalar === ScalarType.BOOL)
  );
}

function parseBoolean(raw: string): boolean {
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  throw new CmdProtoError("INVALID_ARGUMENT", `Invalid boolean value: ${raw}`);
}

function parseNumber(raw: string, fieldName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CmdProtoError("INVALID_ARGUMENT", `Invalid number for ${fieldName}: ${raw}`);
  }
  return value;
}

function jsonTextResult(value: unknown, statusCode: number): CliResult {
  return {
    statusCode,
    stdout: `${JSON.stringify(value, null, 2)}\n`,
    stderr: ""
  };
}

function jsonEnvelopeResult(value: unknown, statusCode: number): CliResult {
  return {
    statusCode,
    stdout: `${JSON.stringify(value, null, 2)}\n`,
    stderr: ""
  };
}

function textResult(stdout: string): CliResult {
  return {
    statusCode: 0,
    stdout,
    stderr: ""
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
