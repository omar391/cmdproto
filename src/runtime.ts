import {
  fromJson,
  toJson,
  type JsonValue
} from "@bufbuild/protobuf";
import type {
  CmdProtoSchema,
  CommandRequestJson,
  CommandResponseJson,
  HandlerContext,
  HandlerMap,
  JsonObject,
  MethodSpec
} from "./types.js";

const REQUEST_KEYS = new Set(["method", "params", "requestId"]);

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
    const message = fromJson(method.input, params, {
      ignoreUnknownFields: false,
      registry: schema.registry
    });
    return toJson(method.input, message, {
      registry: schema.registry
    }) as JsonObject;
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
    const message = fromJson(method.output, result ?? {}, {
      ignoreUnknownFields: false,
      registry: schema.registry
    });
    return toJson(method.output, message, {
      registry: schema.registry
    }) as JsonValue;
  } catch (error) {
    throw new CmdProtoError("INVALID_RESULT", formatError(error));
  }
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
