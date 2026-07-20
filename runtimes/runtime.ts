import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  type DescMethodUnary,
  type FileRegistry,
  type JsonObject as BufJsonObject,
  type JsonValue,
  type Message,
  type MessageShape
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import {
  RuntimeFlagValueMode,
  RuntimeJsonTypeKind,
  RuntimeManifestSchema,
  type RuntimeCommand as ManifestCommand,
  type RuntimeFlagBinding,
  type RuntimeHelpSurface,
  type RuntimeJsonType,
  type RuntimeManifest,
  type RuntimeParam
} from "./gen/cmdproto/v1/runtime_pb.js";
import { CmdProtoError } from "./errors.js";

export { CmdProtoError } from "./errors.js";

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

export interface JsonPayloadOptions {}

export interface ParamOptions {
  positional?: PositionalOptions;
  flag?: FlagOptions;
  json?: JsonPayloadOptions;
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

interface DescriptorRuntimeSchema {
  registry: FileRegistry;
  methodByName: Map<string, DescMethod>;
}

interface RuntimeCommandSpec {
  manifest: ManifestCommand;
  method: DescMethod;
  bindings: string[][];
  flagByToken: Map<string, RuntimeFlagBinding>;
  paramByJsonName: Map<string, RuntimeParam>;
}

type SchemaJsonField = DescField & {
  mapValue?: DescField;
  listKind?: "message" | "enum" | "scalar";
  message?: DescMessage;
  enum?: { values: Array<{ name: string }> };
  scalar?: ScalarType;
};

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

const COMMAND_OUTCOME = Symbol("cmdproto.commandOutcome");

export interface CommandOutcome {
  result: JsonValue;
  statusCode: number;
  [COMMAND_OUTCOME]: true;
}

export type CommandHandlerResult = JsonValue | CommandOutcome;

export interface HandlerContext {
  methodName: string;
  descriptor: DescMethod;
  request: CommandRequestJson;
  requestContext?: unknown;
}

export type CmdProtoHandler = (
  params: JsonObject,
  context: HandlerContext
) => CommandHandlerResult | Promise<CommandHandlerResult>;

export type HandlerMap = Record<string, CmdProtoHandler>;

export interface CliResult {
  statusCode: number;
  stdout: string;
  stderr: string;
}

export interface AppOptions {
  handlers: HandlerMap;
  schemaPath?: string;
  manifestPath?: string;
  renderHuman?: HumanRenderer;
  transport?: CommandTransport;
}

export interface RunMainOptions extends AppOptions {
  argv?: string[];
  stdin?: string;
}

export interface CommandDispatchOptions {
  requestContext?: unknown;
}

export interface CommandTransport {
  dispatch(
    runtime: CmdProtoRuntime,
    request: CommandRequestJson
  ): Promise<CommandOutcome>;
}

export interface ProtobufCommandRequest {
  request: CommandRequestJson;
  method: DescMethodUnary;
  message: Message;
}

const COMMAND_OPTION = "cmdproto.v1.command";
const PARAM_OPTION = "cmdproto.v1.param";
const REQUEST_KEYS = new Set(["method", "params", "requestId"]);
const COMMAND_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LONG_FLAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHORT_FLAG_RE = /^[A-Za-z0-9]$/;
const RESERVED_COMMAND_ROOTS = new Set(["cmdproto"]);
const RESERVED_LONG_FLAGS = new Set(["help", "json"]);
const RESERVED_SHORT_FLAGS = new Set(["h"]);
const HELP_FLAG = "--help";
const JSON_FLAG = "--json";
const EXECJSON_USAGE = "cmdproto execjson <path> <json|@file|@->";
const EXECJSON_SUMMARY = "Execute a machine JSON payload for a command path.";

export interface HumanRenderContext {
  methodName: string;
  descriptor: DescMethod;
  request: CommandRequestJson;
}

export type HumanRenderer = (
  outcome: CommandOutcome,
  context: HumanRenderContext
) => CliResult;

interface CommandBinding {
  key: string;
  tokens: string[];
  method: MethodSpec;
  source: string;
  positionalCount: number;
}

export function commandOutcome(
  result: JsonValue,
  options: { statusCode?: number } = {}
): CommandOutcome {
  return {
    [COMMAND_OUTCOME]: true,
    result,
    statusCode: normalizeStatusCode(options.statusCode ?? 0)
  };
}

function normalizeStatusCode(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

function isCommandOutcome(value: unknown): value is CommandOutcome {
  return isPlainObject(value) && (value as { [COMMAND_OUTCOME]?: true })[COMMAND_OUTCOME] === true;
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

function loadDescriptorRuntimeSchemaFromFile(path: string): DescriptorRuntimeSchema {
  return loadDescriptorRuntimeSchemaFromBinary(readFileSync(path));
}

function loadDescriptorRuntimeSchemaFromBinary(bytes: Uint8Array): DescriptorRuntimeSchema {
  const fileDescriptorSet = fromBinary(FileDescriptorSetSchema, bytes);
  const registry = createFileRegistry(fileDescriptorSet);
  const methodByName = new Map<string, DescMethod>();

  for (const descriptor of registry) {
    if (descriptor.kind !== "service") {
      continue;
    }
    for (const method of descriptor.methods) {
      methodByName.set(`${descriptor.typeName}.${method.name}`, method);
    }
  }

  return { registry, methodByName };
}

function loadRuntimeManifestFromFile(path: string): RuntimeManifest {
  return fromBinary(RuntimeManifestSchema, readFileSync(path));
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
      if (method.methodKind !== "unary") {
        throw new Error(`${descriptor.typeName}.${method.name} cmdproto command methods must be unary`);
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
  const json = value?.json !== undefined ? {} : undefined;

  return {
    ...(positional ? { positional } : {}),
    ...(flag ? { flag } : {}),
    ...(json ? { json } : {}),
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
    if (splitCommandPath(command)[0] === "cmdproto") {
      throw new Error(`${method.name} example "${command}" must be human command syntax, not cmdproto control syntax`);
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
  return canonicalizeJsonMessage(
    method.input,
    parseJsonRequest(rawRequest) as JsonValue,
    registry
  ) as JsonObject;
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

  if (getJsonPayloadField(method)) {
    parts.push("[--json <json|@file|@->]");
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
    const json = field.param.json;

    if ([Boolean(positional), Boolean(flag), Boolean(json)].filter(Boolean).length > 1) {
      throw new Error(
        `${method.name}.${field.name} can only use one cmdproto binding: positional, flag, or json`
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

    if (json) {
      if (!supportsJsonPayload(field.descriptor)) {
        throw new Error(
          `${method.name}.${field.name} must be message, map, or list typed to be JSON-bound in cmdproto`
        );
      }
      registerJsonPayload(seenFlags, method, field);
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

function registerJsonPayload(
  seenFlags: Map<string, string>,
  method: MethodSpec,
  field: FieldSpec
): void {
  const key = "long:json";
  const existing = seenFlags.get(key);
  if (existing) {
    throw new Error(
      `${method.name} reuses JSON payload binding "--json" for ${field.name} and ${existing}`
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

function supportsJsonPayload(field: DescField): boolean {
  return field.fieldKind === "message" || field.fieldKind === "map" || field.fieldKind === "list";
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

function getJsonPayloadField(method: MethodSpec): FieldSpec | undefined {
  return method.fields.find((field) => field.param.json && !field.param.hidden);
}

export class CmdProtoRuntime {
  readonly schema: DescriptorRuntimeSchema;
  readonly manifest: RuntimeManifest;
  readonly commands: RuntimeCommandSpec[];
  readonly commandByMethod: Map<string, RuntimeCommandSpec>;
  readonly handlers: HandlerMap;
  readonly renderHuman?: HumanRenderer;

  constructor(
    schema: DescriptorRuntimeSchema,
    manifest: RuntimeManifest,
    commands: RuntimeCommandSpec[],
    handlers: HandlerMap,
    renderHuman?: HumanRenderer
  ) {
    this.schema = schema;
    this.manifest = manifest;
    this.commands = commands;
    this.commandByMethod = new Map(commands.map((command) => [command.manifest.method, command]));
    this.handlers = handlers;
    this.renderHuman = renderHuman;
  }

  async dispatch(
    input: unknown,
    options: CommandDispatchOptions = {}
  ): Promise<CommandOutcome> {
    const request = normalizeRequest(input);

    const descriptor = this.schema.methodByName.get(request.method);
    if (!descriptor) {
      throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown method: ${request.method}`);
    }

    const handler = this.handlers[request.method];
    if (!handler) {
      throw new CmdProtoError("HANDLER_NOT_FOUND", `No handler registered for ${request.method}`);
    }

    const params = validateParams(this.schema, descriptor, request.params ?? {});
    const context: HandlerContext = {
      methodName: request.method,
      descriptor,
      request,
      requestContext: options.requestContext
    };
    const rawResult = await handler(params, context);
    const rawOutcome = isCommandOutcome(rawResult)
      ? rawResult
      : commandOutcome(rawResult);
    return commandOutcome(
      validateResult(this.schema, descriptor, rawOutcome.result),
      { statusCode: rawOutcome.statusCode }
    );
  }

  prepareProtobufRequest(input: unknown): ProtobufCommandRequest {
    const request = normalizeRequest(input);
    const method = this.requireUnaryCommand(request.method);
    const params = validateParams(this.schema, method, request.params ?? {});
    return {
      request: { ...request, params },
      method,
      message: fromJson(method.input, params, {
        ignoreUnknownFields: false,
        registry: this.schema.registry
      })
    };
  }

  decodeProtobufResponse(
    methodName: string,
    message: MessageShape<DescMessage>
  ): CommandOutcome {
    const method = this.requireUnaryCommand(methodName);
    const result = validateResult(
      this.schema,
      method,
      toJson(method.output, message, { registry: this.schema.registry }) as JsonValue
    );
    return commandOutcome(result);
  }

  async dispatchProtobuf(
    methodName: string,
    message: MessageShape<DescMessage>,
    options: CommandDispatchOptions = {}
  ): Promise<Message> {
    const method = this.requireUnaryCommand(methodName);
    const params = toJson(method.input, message, {
      registry: this.schema.registry
    }) as JsonValue;
    const outcome = await this.dispatch({ method: methodName, params }, options);
    return fromJson(
      method.output,
      wrapTransparentOutputResult(method.output, outcome.result),
      {
        ignoreUnknownFields: false,
        registry: this.schema.registry
      }
    );
  }

  private requireUnaryCommand(methodName: string): DescMethodUnary {
    const command = this.commandByMethod.get(methodName);
    if (!command) {
      throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command method: ${methodName}`);
    }
    if (command.method.methodKind !== "unary") {
      throw new CmdProtoError(
        "UNIMPLEMENTED",
        `Cmdproto command method must be unary: ${methodName}`
      );
    }
    return command.method as DescMethodUnary;
  }
}

export function createRuntime(
  schema: DescriptorRuntimeSchema,
  manifest: RuntimeManifest,
  handlers: HandlerMap,
  renderHuman?: HumanRenderer
): CmdProtoRuntime {
  const commands = buildRuntimeCommandSpecs(schema, manifest);
  return new CmdProtoRuntime(schema, manifest, commands, handlers, renderHuman);
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
  schema: DescriptorRuntimeSchema,
  method: DescMethod,
  params: JsonValue
): JsonObject {
  try {
    return canonicalizeJsonMessage(method.input, params, schema.registry) as JsonObject;
  } catch (error) {
    throw new CmdProtoError("INVALID_ARGUMENT", formatError(error));
  }
}

function validateResult(
  schema: DescriptorRuntimeSchema,
  method: DescMethod,
  result: JsonValue
): JsonValue {
  try {
    const validated = canonicalizeJsonMessage(
      method.output,
      wrapTransparentOutputResult(method.output, result),
      schema.registry
    );
    return unwrapTransparentOutputResult(method.output, validated);
  } catch (error) {
    throw new CmdProtoError("INVALID_RESULT", formatError(error));
  }
}

function wrapTransparentOutputResult(
  message: DescMessage,
  result: JsonValue
): JsonValue {
  const field = getTransparentOutputField(message);
  if (!field) {
    return result ?? {};
  }
  if (isPlainObject(result) && "output" in result && Object.keys(result).length === 1) {
    return result as JsonValue;
  }
  return { output: result ?? {} };
}

function unwrapTransparentOutputResult(
  message: DescMessage,
  result: JsonValue
): JsonValue {
  const field = getTransparentOutputField(message);
  if (!field || !isPlainObject(result) || !("output" in result)) {
    return result;
  }
  return (result as Record<string, JsonValue>).output ?? {};
}

function getTransparentOutputField(message: DescMessage): DescField | undefined {
  if (message.fields.length !== 1) {
    return undefined;
  }
  const [field] = message.fields;
  if (!field || field.name !== "output") {
    return undefined;
  }
  return field.fieldKind === "message" || field.fieldKind === "map" || field.fieldKind === "list"
    ? field
    : undefined;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getDefaultSchemaPath(cwd = process.cwd()): string {
  return join(cwd, "dist/schema.binpb");
}

export function getDefaultManifestPath(cwd = process.cwd()): string {
  return join(cwd, "dist/runtime.binpb");
}

export function createRuntimeFromFile(
  handlers: HandlerMap,
  schemaPath = getDefaultSchemaPath(),
  manifestPath = getDefaultManifestPath(),
  renderHuman?: HumanRenderer
): CmdProtoRuntime {
  const schemaBytes = readFileSync(schemaPath);
  const schema = loadDescriptorRuntimeSchemaFromBinary(schemaBytes);
  const manifest = loadRuntimeManifestFromFile(manifestPath);
  const schemaHash = createHash("sha256").update(schemaBytes).digest("hex");
  if (manifest.descriptorSetSha256 !== schemaHash) {
    throw new Error(
      `runtime manifest descriptor hash mismatch: expected ${schemaHash}, got ${manifest.descriptorSetSha256 || "(missing)"}`
    );
  }
  return createRuntime(schema, manifest, handlers, renderHuman);
}

export async function executeApp({
  handlers,
  schemaPath = getDefaultSchemaPath(),
  manifestPath = getDefaultManifestPath(),
  renderHuman,
  transport,
  argv = process.argv.slice(2),
  stdin
}: RunMainOptions): Promise<CliResult> {
  // The app runtime stays transport-neutral. `runCli()` owns one-shot
  // presentation and may delegate a finite command through an explicit transport.
  const runtime = createRuntimeFromFile(handlers, schemaPath, manifestPath, renderHuman);
  return runCli(runtime, argv, await resolveCliStdin(argv, stdin), transport);
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
  stdin = "",
  transport?: CommandTransport
): Promise<CliResult> {
  const normalizedArgv = normalizeCliArgv(argv);
  try {
    const helpResult = runRuntimeHelpCommand(runtime, normalizedArgv);
    if (helpResult) {
      return helpResult;
    }

    const controlResult = await runCmdprotoCommand(
      runtime,
      normalizedArgv,
      stdin,
      transport
    );
    if (controlResult) {
      return controlResult;
    }

    const request = parseManifestHumanCommand(runtime, normalizedArgv, stdin);
    const outcome = await dispatchCommand(runtime, request, transport);
    return renderHumanResult(runtime, outcome, request);
  } catch (error) {
    return isCmdprotoControl(normalizedArgv)
      ? jsonTextResult({ error: commandErrorJson(error) }, 1)
      : humanErrorResult(error);
  }
}

function renderHumanResult(
  runtime: CmdProtoRuntime,
  outcome: CommandOutcome,
  request: CommandRequestJson
): CliResult {
  const descriptor = runtime.schema.methodByName.get(request.method);
  if (!descriptor) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown method: ${request.method}`);
  }
  if (runtime.renderHuman) {
    return runtime.renderHuman(outcome, {
      methodName: request.method,
      descriptor,
      request
    });
  }
  return jsonTextResult(outcome.result, outcome.statusCode);
}

function humanErrorResult(error: unknown): CliResult {
  const normalized = commandErrorJson(error);
  return {
    statusCode: 1,
    stdout: "",
    stderr: `${normalized.message}\n`
  };
}

function commandErrorJson(error: unknown): CommandErrorJson {
  const normalized =
    error instanceof CmdProtoError
      ? error
      : new CmdProtoError("INTERNAL", formatError(error));
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.details === undefined ? {} : { details: normalized.details })
  };
}

function isCmdprotoControl(argv: string[]): boolean {
  return argv[0] === "cmdproto";
}

function normalizeCliArgv(argv: string[]): string[] {
  let start = 0;
  while (argv[start] === "--") {
    start += 1;
  }
  return start === 0 ? argv : argv.slice(start);
}

function buildRuntimeCommandSpecs(
  schema: DescriptorRuntimeSchema,
  manifest: RuntimeManifest
): RuntimeCommandSpec[] {
  const seenBindings = new Map<string, string>();

  return manifest.commands.map((command) => {
    const method = schema.methodByName.get(command.method);
    if (!method) {
      throw new Error(`Runtime manifest references unknown method ${command.method}`);
    }
    if (command.inputType !== method.input.typeName) {
      throw new Error(
        `Runtime manifest input type mismatch for ${command.method}: expected ${method.input.typeName}, got ${command.inputType}`
      );
    }
    if (command.outputType !== method.output.typeName) {
      throw new Error(
        `Runtime manifest output type mismatch for ${command.method}: expected ${method.output.typeName}, got ${command.outputType}`
      );
    }

    const flagByToken = new Map<string, RuntimeFlagBinding>();
    for (const flag of command.parsePlan?.flags ?? []) {
      flagByToken.set(flag.token, flag);
    }

    const paramByJsonName = new Map<string, RuntimeParam>();
    for (const param of command.params) {
      paramByJsonName.set(param.jsonName, param);
    }

    const bindings = command.bindings.map((binding) => splitCommandPath(binding));
    for (const binding of command.bindings) {
      const existing = seenBindings.get(binding);
      if (existing) {
        throw new Error(
          `Runtime manifest reuses command binding "${binding}" for ${command.method} and ${existing}`
        );
      }
      seenBindings.set(binding, command.method);
    }

    return {
      manifest: command,
      method,
      bindings,
      flagByToken,
      paramByJsonName
    };
  });
}

function parseManifestHumanCommand(
  runtime: CmdProtoRuntime,
  argv: string[],
  stdin = ""
): CommandRequestJson {
  const match = findRuntimeCommand(runtime.commands, argv);
  if (!match) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${argv.join(" ")}`);
  }

  return {
    method: match.command.manifest.method,
    params: parseManifestArguments(
      match.command,
      argv.slice(match.tokens.length),
      stdin
    )
  };
}

function findRuntimeCommand(
  commands: RuntimeCommandSpec[],
  argv: string[]
): { command: RuntimeCommandSpec; tokens: string[] } | undefined {
  const candidates: { command: RuntimeCommandSpec; tokens: string[] }[] = [];

  for (const command of commands) {
    for (const tokens of command.bindings) {
      if (tokens.length > 0 && startsWith(argv, tokens)) {
        candidates.push({ command, tokens });
      }
    }
  }

  candidates.sort((left, right) => right.tokens.length - left.tokens.length);
  return candidates[0];
}

function findExactRuntimeCommand(
  commands: RuntimeCommandSpec[],
  argv: string[]
): { command: RuntimeCommandSpec; tokens: string[] } | undefined {
  const match = findRuntimeCommand(commands, argv);
  if (!match || match.tokens.length !== argv.length) {
    return undefined;
  }
  return match;
}

function parseManifestArguments(
  command: RuntimeCommandSpec,
  argv: string[],
  stdin = ""
): JsonObject {
  const params: JsonObject = {};
  const positionals = (command.manifest.parsePlan?.positionalJsonNames ?? []).map((jsonName) => {
    const param = command.paramByJsonName.get(jsonName);
    if (!param) {
      throw new Error(`Runtime manifest is missing positional param ${jsonName}`);
    }
    return param;
  });
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
      const binding = command.flagByToken.get(parsed.name);
      if (!binding) {
        throw new CmdProtoError("INVALID_ARGUMENT", `Unknown flag: ${parsed.name}`);
      }
      const param = command.paramByJsonName.get(binding.jsonName);
      if (!param) {
        throw new Error(`Runtime manifest is missing flag param ${binding.jsonName}`);
      }
      const { value, consumedNext, replace } = parseManifestFlagValue(
        param,
        binding,
        parsed.value,
        argv[index + 1],
        stdin
      );
      setManifestParam(params, param, value, replace);
      if (consumedNext) {
        index += 1;
      }
      continue;
    }

    const param = positionals[positionalIndex];
    if (!param) {
      throw new CmdProtoError("INVALID_ARGUMENT", `Unexpected positional argument: ${token}`);
    }
    setManifestParam(params, param, parseManifestCliValue(param, token));
    positionalIndex += 1;
  }

  for (const param of positionals) {
    if (!(param.jsonName in params)) {
      throw new CmdProtoError("INVALID_ARGUMENT", `Missing positional argument: ${param.protoName}`);
    }
  }

  return params;
}

function parseManifestFlagValue(
  param: RuntimeParam,
  binding: RuntimeFlagBinding,
  inlineValue: string | undefined,
  nextValue: string | undefined,
  stdin = ""
): { value: JsonValue; consumedNext: boolean; replace?: boolean } {
  if (binding.valueMode === RuntimeFlagValueMode.BOOLEAN_OPTIONAL) {
    return {
      value: inlineValue === undefined ? true : parseBoolean(inlineValue),
      consumedNext: false
    };
  }

  const value = inlineValue ?? nextValue;
  if (value === undefined) {
    throw new CmdProtoError("INVALID_ARGUMENT", `Flag ${binding.token} requires a value`);
  }
  if (binding.token === JSON_FLAG) {
    return {
      value: parseJsonRequestInput(value, stdin) as JsonValue,
      consumedNext: inlineValue === undefined,
      replace: true
    };
  }
  return {
    value: parseManifestCliValue(param, value),
    consumedNext: inlineValue === undefined
  };
}

function setManifestParam(
  params: JsonObject,
  param: RuntimeParam,
  value: JsonValue,
  replace = false
): void {
  if (replace) {
    params[param.jsonName] = value;
    return;
  }
  if (param.jsonType?.kind === RuntimeJsonTypeKind.ARRAY) {
    const current = params[param.jsonName];
    params[param.jsonName] = Array.isArray(current) ? [...current, value] : [value];
    return;
  }
  params[param.jsonName] = value;
}

function parseManifestCliValue(
  param: RuntimeParam,
  raw: string
): JsonValue {
  const jsonType = param.jsonType;
  if (!jsonType) {
    throw new Error(`Runtime manifest is missing json_type for ${param.jsonName}`);
  }
  return parseManifestValueByType(jsonType, raw, param.protoName);
}

function parseManifestValueByType(
  jsonType: RuntimeJsonType,
  raw: string,
  fieldName: string
): JsonValue {
  switch (jsonType.kind) {
    case RuntimeJsonTypeKind.BOOLEAN:
      return parseBoolean(raw);
    case RuntimeJsonTypeKind.NUMBER:
      return parseNumber(raw, fieldName);
    case RuntimeJsonTypeKind.STRING:
      return raw;
    case RuntimeJsonTypeKind.ARRAY:
      switch (jsonType.elementKind) {
        case RuntimeJsonTypeKind.BOOLEAN:
          return parseBoolean(raw);
        case RuntimeJsonTypeKind.NUMBER:
          return parseNumber(raw, fieldName);
        case RuntimeJsonTypeKind.STRING:
          return raw;
        default:
          break;
      }
      break;
    default:
      break;
  }

  throw new CmdProtoError("INVALID_ARGUMENT", `Field ${fieldName} is not CLI-scalar`);
}

export function parseHumanCommand(
  schema: CmdProtoSchema,
  argv: string[],
  stdin = ""
): CommandRequestJson {
  const match = findCommand(schema.methods, argv);
  if (!match) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${argv.join(" ")}`);
  }

  const params = parseArguments(
    match.method,
    argv.slice(match.tokens.length),
    stdin
  );
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
    "",
    "Notes:",
    "  --help includes machine execution notes and type names.",
    "  --help --json prints compact payload-schema JSON.",
    "",
    "Machine control:",
    `  ${EXECJSON_USAGE.padEnd(36)} ${EXECJSON_SUMMARY}`.trimEnd()
  );
  return `${lines.join("\n")}\n`;
}

async function runCmdprotoCommand(
  runtime: CmdProtoRuntime,
  argv: string[],
  stdin: string,
  transport?: CommandTransport
): Promise<CliResult | undefined> {
  // This one-shot control surface deliberately handles finite command invocations.
  if (argv[0] !== "cmdproto") {
    return undefined;
  }

  if (argv[1] === "execjson") {
    const executeArgv = argv.slice(2);
    if (executeArgv.length < 2) {
      throw new CmdProtoError("INVALID_ARGUMENT", `Usage: ${EXECJSON_USAGE}`);
    }

    const pathTokens = executeArgv.slice(0, -1);
    const match = findExactRuntimeCommand(runtime.commands, pathTokens);
    if (!match) {
      throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${pathTokens.join(" ")}`);
    }

    const params = parseJsonRequestInput(
      executeArgv[executeArgv.length - 1],
      stdin
    ) as JsonValue;
    const outcome = await dispatchCommand(runtime, {
      method: match.command.manifest.method,
      params
    }, transport);
    return jsonTextResult(outcome.result, outcome.statusCode);
  }

  throw new CmdProtoError(
    "INVALID_ARGUMENT",
    `Unknown cmdproto command: ${argv.slice(1).join(" ")}`
  );
}

function dispatchCommand(
  runtime: CmdProtoRuntime,
  request: CommandRequestJson,
  transport?: CommandTransport
): Promise<CommandOutcome> {
  return transport
    ? transport.dispatch(runtime, request)
    : runtime.dispatch(request);
}

function runRuntimeHelpCommand(runtime: CmdProtoRuntime, argv: string[]): CliResult | undefined {
  if (argv.length === 0) {
    return renderRuntimeHelpSurface(runtime.manifest.rootHelp, false);
  }

  const helpRequested = argv.includes(HELP_FLAG);
  if (!helpRequested && !(argv[0] === "cmdproto" && argv.length === 1)) {
    return undefined;
  }

  const json = helpRequested && argv.includes(JSON_FLAG);
  const filtered = helpRequested
    ? argv.filter((token) => token !== HELP_FLAG && token !== JSON_FLAG)
    : argv;

  if (filtered.length === 0) {
    return renderRuntimeHelpSurface(runtime.manifest.rootHelp, json);
  }

  if (filtered[0] === "cmdproto") {
    if (filtered.length === 1) {
      return renderRuntimeHelpSurface(runtime.manifest.controlHelp, json);
    }
    if (filtered.length === 2 && filtered[1] === "execjson") {
      return renderRuntimeHelpSurface(runtime.manifest.execute?.help, json);
    }
    throw new CmdProtoError(
      "INVALID_ARGUMENT",
      `Unknown cmdproto command: ${filtered.slice(1).join(" ")}`
    );
  }

  const match = findExactRuntimeCommand(runtime.commands, filtered);
  if (!match) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${filtered.join(" ")}`);
  }

  return renderRuntimeHelpSurface(match.command.manifest.help, json);
}

function renderRuntimeHelpSurface(
  surface: RuntimeHelpSurface | undefined,
  json: boolean
): CliResult {
  if (!surface) {
    throw new Error("Runtime manifest is missing help output");
  }
  return json ? rawJsonTextResult(surface.json, 0) : textResult(surface.text);
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
  const filtered = helpRequested
    ? argv.filter((token) => token !== HELP_FLAG && token !== JSON_FLAG)
    : argv;

  if (filtered.length === 0) {
    return json ? renderJsonHelp(buildMinimalGlobalHelpJson(schema)) : textResult(renderHelp(schema));
  }

  if (filtered[0] === "cmdproto") {
    return renderCmdprotoHelp(filtered.slice(1), json);
  }

  const match = findExactCommand(schema.methods, filtered);
  if (!match) {
    throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown command: ${filtered.join(" ")}`);
  }

  return json ? renderJsonHelp(buildMinimalMethodHelpJson(match.method)) : textResult(renderMethodHelp(match.method));
}

function renderCmdprotoHelp(argv: string[], json: boolean): CliResult {
  if (argv.length === 0) {
    return json ? renderJsonHelp(buildMinimalCmdprotoIndexJson()) : textResult(renderCmdprotoIndexHelp());
  }

  if (argv.length === 1 && argv[0] === "execjson") {
    return json ? renderJsonHelp(buildMinimalExecJsonHelpJson()) : textResult(renderExecJsonHelp());
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
        path: getPreferredMachineCommandPath(method),
        ...(method.command.summary ? { summary: method.command.summary } : {})
      })),
    execjson: buildMinimalExecJsonHelpJson()
  };
}

function buildMinimalMethodHelpJson(method: MethodSpec): JsonObject {
  return {
    method: method.name,
    path: getPreferredMachineCommandPath(method),
    ...(method.command.alias.length > 0 ? { aliases: method.command.alias } : {}),
    input_type: method.input.typeName,
    output_type: method.output.typeName,
    machine_usage: renderExecJsonTemplate(method),
    payload_json_schema: buildMessageJsonSchema(method.input),
    payload_schema: buildMinimalFieldsJson(method),
    examples: method.command.example.map((example) => buildMinimalExampleHelpJson(method, example))
  };
}

function buildMinimalExampleHelpJson(method: MethodSpec, example: CliExample): JsonObject {
  return {
    ...(example.description ? { description: example.description } : {}),
    cmd: renderExecJsonExampleCommand(method, example.requestJson)
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
    type: renderJsonFieldType(field.descriptor),
    ...(field.param.help ? { help: field.param.help } : {})
  };
}

function renderJsonFieldType(field: DescField): string {
  switch (field.fieldKind) {
    case "scalar":
      return renderJsonScalarType(field.scalar);
    case "enum":
      return "string";
    case "list":
      if (field.listKind === "scalar") {
        return `array<${renderJsonScalarType(field.scalar)}>`;
      }
      if (field.listKind === "enum") {
        return "array<string>";
      }
      return "array<object>";
    case "map":
      return "object";
    default:
      return "object";
  }
}

function renderJsonScalarType(scalar: ScalarType): string {
  switch (scalar) {
    case ScalarType.BOOL:
      return "boolean";
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return "number";
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.STRING:
    case ScalarType.BYTES:
      return "string";
    default:
      return "string";
  }
}

function buildMinimalCmdprotoIndexJson(): JsonObject {
  return {
    execjson: buildMinimalExecJsonHelpJson()
  };
}

function buildExecJsonHelpSummaryJson(): JsonObject {
  return {
    name: "cmdproto execjson",
    usage: EXECJSON_USAGE,
    summary: EXECJSON_SUMMARY
  };
}

function buildMinimalExecJsonHelpJson(): JsonObject {
  return buildExecJsonHelpSummaryJson();
}

function renderCmdprotoIndexHelp(): string {
  const lines = [
    "Machine control:",
    "",
    `  ${EXECJSON_USAGE.padEnd(36)} ${EXECJSON_SUMMARY}`.trimEnd()
  ];
  return `${lines.join("\n")}\n`;
}

function renderExecJsonHelp(): string {
  const lines = [
    EXECJSON_SUMMARY,
    "",
    "Usage:",
    `  ${EXECJSON_USAGE}`,
    "",
    "Notes:",
    "  <path> resolves a declared command path or alias.",
    "  <json> can be inline JSON, @file, or @- for stdin."
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
    `  ${method.name}`,
    "",
    "Machine execjson:",
    `  ${renderExecJsonTemplate(method)}`,
    "",
    "Payload type:",
    `  ${method.input.typeName}`,
    "Result type:",
    `  ${method.output.typeName}`
  ];

  if (method.command.alias.length > 0) {
    lines.push("", "Aliases:", `  ${method.command.alias.join(", ")}`);
  }

  lines.push("", "Parameters:", ...renderHelpTable(
    ["CLI param", "JSON param", "Position", "Type", "Description"],
    getHelpFields(method).map((field) => [
      renderCliFieldLabel(field),
      field.jsonName,
      renderFieldPosition(field),
      renderJsonFieldType(field.descriptor),
      field.param.help
    ])
  ));

  if (method.command.example.length > 0) {
    lines.push(
      "",
      "Examples:",
      ...renderHelpTable(
        ["Description", "Normal cmd", "JSON cmd"],
        method.command.example.map((example) => [
          example.description,
          example.command,
          renderExecJsonExampleCommand(method, example.requestJson)
        ])
      )
    );
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
    .filter((field) => field.param.flag && !field.param.positional && !field.param.hidden)
    .sort((left, right) => renderCliFieldLabel(left).localeCompare(renderCliFieldLabel(right)));
  const payloadOnly = method.fields
    .filter((field) => !field.param.positional && !field.param.flag && !field.param.json && !field.param.hidden)
    .sort((left, right) => left.jsonName.localeCompare(right.jsonName));
  const jsonPayload = method.fields.filter((field) => field.param.json && !field.param.hidden);

  return [...positionals, ...flags, ...jsonPayload, ...payloadOnly];
}

function renderCliFieldLabel(field: FieldSpec): string {
  if (field.param.positional) {
    return `<${field.name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}>`;
  }
  if (field.param.json) {
    return "--json";
  }
  const flag = field.param.flag;
  if (!flag) {
    return "-";
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

function renderFieldPosition(field: FieldSpec): string {
  return field.param.positional ? String(field.param.positional.index) : "-";
}

function renderHelpTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[index] ?? "").length)
    )
  );

  const renderRow = (row: string[]) =>
    `  ${row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ")}`.trimEnd();

  return [
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(renderRow)
  ];
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

function renderExecJsonTemplate(method: MethodSpec): string {
  return `cmdproto execjson ${getPreferredMachineCommandPath(method)} <json|@file|@->`;
}

function renderExecJsonExampleCommand(method: MethodSpec, requestJson: string): string {
  const payload = normalizeExamplePayload(requestJson);
  return `cmdproto execjson ${getPreferredMachineCommandPath(method)} ${quoteShellArgument(
    JSON.stringify(payload)
  )}`;
}

function buildMessageJsonSchema(message: DescMessage): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `cmdproto://message/${message.typeName}`,
    title: message.typeName,
    type: "object",
    additionalProperties: false,
    required: message.fields
      .filter((field) => field.proto.label === 2)
      .map((field) => field.jsonName),
    properties: Object.fromEntries(
      message.fields.map((field) => [field.jsonName, buildFieldJsonSchema(field)])
    ) as JsonObject
  };
}

function buildFieldJsonSchema(field: DescField): JsonObject {
  const schemaField = field as SchemaJsonField;
  if (field.fieldKind === "map") {
    return {
      type: "object",
      additionalProperties: schemaField.mapValue
        ? buildFieldJsonSchema(schemaField.mapValue)
        : true
    };
  }

  if (field.fieldKind === "list") {
    return {
      type: "array",
      items: buildListItemJsonSchema(field)
    };
  }

  if (field.fieldKind === "message") {
    return buildMessageJsonSchema(schemaField.message as DescMessage);
  }

  if (field.fieldKind === "enum") {
    return {
      type: "string",
      enum: (schemaField.enum?.values ?? []).map((value) => value.name)
    };
  }

  return buildScalarJsonSchema(schemaField.scalar as ScalarType);
}

function buildListItemJsonSchema(field: DescField): JsonObject {
  const schemaField = field as SchemaJsonField;
  switch (schemaField.listKind) {
    case "message":
      return buildMessageJsonSchema(schemaField.message as DescMessage);
    case "enum":
      return {
        type: "string",
        enum: (schemaField.enum?.values ?? []).map((value) => value.name)
      };
    case "scalar":
      return buildScalarJsonSchema(schemaField.scalar as ScalarType);
    default:
      return { type: "object" };
  }
}

function buildScalarJsonSchema(scalar: ScalarType): JsonObject {
  switch (scalar) {
    case ScalarType.BOOL:
      return { type: "boolean" };
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return { type: "number" };
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.STRING:
    case ScalarType.BYTES:
    default:
      return { type: "string" };
  }
}

function parseJsonRequestInput(spec: string | undefined, stdin: string): unknown {
  if (spec === undefined) {
    throw new CmdProtoError("INVALID_REQUEST", "Missing JSON request");
  }
  if (spec === "@-") {
    return parseJsonRequest(stdin);
  }
  if (spec.startsWith("@")) {
    try {
      return parseJsonRequest(readFileSync(spec.slice(1), "utf8"));
    } catch (error) {
      throw new CmdProtoError("INVALID_REQUEST", formatError(error));
    }
  }
  return parseJsonRequest(spec);
}

async function resolveCliStdin(
  argv: string[],
  stdin: string | undefined
): Promise<string> {
  if (stdin !== undefined) {
    return stdin;
  }
  const normalizedArgv = normalizeCliArgv(argv);
  if (!commandReadsStdin(normalizedArgv) || process.stdin.isTTY) {
    return "";
  }
  return readProcessStdin();
}

function commandReadsStdin(argv: string[]): boolean {
  if (argv[0] === "cmdproto" && argv[1] === "execjson") {
    return argv[argv.length - 1] === "@-";
  }
  const jsonIndex = argv.indexOf(JSON_FLAG);
  return !argv.includes(HELP_FLAG) && jsonIndex >= 0 && argv[jsonIndex + 1] === "@-";
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeExamplePayload(rawRequest: string): JsonValue {
  const parsed = parseJsonRequest(rawRequest) as JsonValue;
  if (
    isPlainObject(parsed) &&
    Object.keys(parsed).every((key) => REQUEST_KEYS.has(key)) &&
    typeof parsed.method === "string"
  ) {
    return normalizeRequest(parsed).params ?? {};
  }
  return parsed;
}

function getPreferredMachineCommandPath(method: MethodSpec): string {
  const candidates = [method.command.path, ...method.command.alias].map((candidate) =>
    normalizeCommandPath(candidate)
  );
  return candidates.reduce((best, candidate) => {
    if (candidate.length < best.length) {
      return candidate;
    }
    return best;
  });
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderJsonHelp(value: JsonObject): CliResult {
  return jsonTextResult(value, 0);
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

function findExactCommand(
  methods: MethodSpec[],
  argv: string[]
): { method: MethodSpec; tokens: string[] } | undefined {
  const match = findCommand(methods, argv);
  if (!match || match.tokens.length !== argv.length) {
    return undefined;
  }
  return match;
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

function parseArguments(
  method: MethodSpec,
  argv: string[],
  stdin = ""
): JsonObject {
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

      const { value, consumedNext, replace } = parseFlagValue(
        field,
        parsed.value,
        argv[index + 1],
        stdin
      );
      setParam(params, field, value, replace);
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
    if (field.param.hidden) {
      continue;
    }
    if (field.param.json) {
      flags.set(JSON_FLAG, field);
      continue;
    }
    if (!field.param.flag) {
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
  nextValue: string | undefined,
  stdin = ""
): { value: JsonValue; consumedNext: boolean; replace?: boolean } {
  if (field.param.json) {
    const value = inlineValue ?? nextValue;
    if (value === undefined) {
      throw new CmdProtoError("INVALID_ARGUMENT", "Flag --json requires a value");
    }
    return {
      value: parseJsonRequestInput(value, stdin) as JsonValue,
      consumedNext: inlineValue === undefined,
      replace: true
    };
  }
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

function setParam(
  params: JsonObject,
  field: FieldSpec,
  value: JsonValue,
  replace = false
): void {
  if (replace) {
    params[field.jsonName] = value;
    return;
  }
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
    stdout: `${JSON.stringify(value)}\n`,
    stderr: ""
  };
}

function rawJsonTextResult(value: string, statusCode: number): CliResult {
  return {
    statusCode,
    stdout: `${value}\n`,
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
