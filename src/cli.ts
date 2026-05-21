import { ScalarType, type DescField, type JsonValue } from "@bufbuild/protobuf";
import type { CmdProtoRuntime } from "./runtime.js";
import { CmdProtoError } from "./runtime.js";
import type {
  CliResult,
  CmdProtoSchema,
  CommandRequestJson,
  FieldSpec,
  JsonObject,
  MethodSpec
} from "./types.js";
import { renderMethodUsage, splitCommandPath } from "./validation.js";

export async function runCli(
  runtime: CmdProtoRuntime,
  argv: string[],
  stdin = ""
): Promise<CliResult> {
  try {
    if (argv.length === 0 || argv[0] === "--help") {
      return textResult(renderHelp(runtime.schema));
    }

    const controlResult = await runCmdprotoCommand(runtime, argv, stdin);
    if (controlResult) {
      return controlResult;
    }

    const request = parseHumanCommand(runtime.schema, argv);
    const response = await runtime.dispatch(request);
    return jsonResult(response, response.ok ? 0 : 1);
  } catch (error) {
    return jsonResult(
      {
        ok: false,
        error:
          error instanceof CmdProtoError
            ? { code: error.code, message: error.message }
            : { code: "INTERNAL", message: formatError(error) },
        events: []
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
    "Control commands:",
    "  cmdproto methods list",
    "  cmdproto methods describe <method>",
    "  cmdproto schema export",
    "  cmdproto invoke --json '<request>'"
  );
  return `${lines.join("\n")}\n`;
}

async function runCmdprotoCommand(
  runtime: CmdProtoRuntime,
  argv: string[],
  stdin: string
): Promise<CliResult | undefined> {
  if (argv[0] !== "cmdproto") {
    return undefined;
  }

  const payload = runCmdprotoQuery(runtime.schema, argv);
  if (payload !== undefined) {
    return jsonResult({ ok: true, result: payload, events: [] }, 0);
  }

  if (argv[1] === "invoke") {
    if (argv[2] !== "--json" || argv.length > 4) {
      throw new CmdProtoError(
        "INVALID_ARGUMENT",
        "Usage: cmdproto invoke --json '<request>'"
      );
    }
    const request = parseJsonRequest(argv[3] ?? stdin);
    const response = await runtime.dispatch(request);
    return jsonResult(response, response.ok ? 0 : 1);
  }

  throw new CmdProtoError(
    "INVALID_ARGUMENT",
    `Unknown cmdproto command: ${argv.slice(1).join(" ")}`
  );
}

function runCmdprotoQuery(schema: CmdProtoSchema, argv: string[]): JsonValue | undefined {
  if (argv[1] === "methods" && argv[2] === "list" && argv.length === 3) {
    return {
      methods: schema.methods
        .filter((method) => !method.command.hidden)
        .map((method) => describeMethod(method, false))
    };
  }

  if (argv[1] === "methods" && argv[2] === "describe" && argv.length === 4) {
    const method = schema.methodByName.get(argv[3] ?? "");
    if (!method) {
      throw new CmdProtoError("METHOD_NOT_FOUND", `Unknown method: ${argv[3]}`);
    }
    return describeMethod(method, true);
  }

  if (argv[1] === "schema" && argv[2] === "export" && argv.length === 3) {
    return {
      format: "file_descriptor_set.binpb.base64",
      schema: Buffer.from(schema.descriptorBytes).toString("base64")
    };
  }

  return undefined;
}

function describeMethod(method: MethodSpec, includeFields: boolean): JsonObject {
  return {
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
    ...(includeFields
      ? {
          fields: method.fields.map((field) => ({
            name: field.name,
            jsonName: field.jsonName,
            positionalIndex: field.param.positional?.index ?? 0,
            longFlag: field.param.flag?.long ?? "",
            shortFlag: field.param.flag?.short ?? "",
            help: field.param.help,
            hidden: field.param.hidden
          })),
        examples: method.command.example.map((example) => ({
            command: example.command,
            description: example.description
          }))
        }
      : {})
  };
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

function findCommand(
  methods: MethodSpec[],
  argv: string[]
): { method: MethodSpec; tokens: string[] } | undefined {
  const candidates: { method: MethodSpec; tokens: string[] }[] = [];

  for (const method of methods) {
    for (const command of [method.command.path, ...method.command.alias]) {
      const tokens = splitCommandPath(command);
      if (tokens.length > 0 && startsWith(argv, tokens)) {
        candidates.push({ method, tokens });
      }
    }
  }

  candidates.sort((left, right) => right.tokens.length - left.tokens.length);
  return candidates[0];
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

function jsonResult(value: unknown, statusCode: number): CliResult {
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
