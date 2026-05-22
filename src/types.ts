import type {
  DescField,
  DescMessage,
  DescMethod,
  FileRegistry,
  JsonObject as BufJsonObject,
  JsonValue
} from "@bufbuild/protobuf";

export type JsonObject = BufJsonObject;

export interface CliExample {
  command: string;
  description: string;
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

// V1 keeps execution unary. If we add live events later, they should arrive on a
// persistent transport adapter rather than being buffered into the final reply.
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
