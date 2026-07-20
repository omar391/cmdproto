import type {
  DescMethodUnary,
  JsonValue,
  Message,
  MessageShape
} from "@bufbuild/protobuf";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext as ConnectHandlerContext,
  type Interceptor
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { CmdProtoError } from "../runtimes/errors.js";
import type {
  CmdProtoRuntime,
  CommandRequestJson,
  CommandTransport
} from "../runtimes/runtime.js";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface CmdProtoConnectRequestInfo {
  methodName: string;
  descriptor: DescMethodUnary;
  request: Message;
  requestHeader: Headers;
  requestMethod: string;
  responseHeader: Headers;
  responseTrailer: Headers;
  signal: AbortSignal;
  timeoutMs: number | undefined;
  url: string;
}

export interface CmdProtoConnectAuthorizedRequest<RequestContext>
  extends CmdProtoConnectRequestInfo {
  requestContext: RequestContext;
}

export interface CmdProtoConnectServerOptions<RequestContext = undefined> {
  runtime: CmdProtoRuntime;
  allowMethods: Iterable<string>;
  authorize(
    request: CmdProtoConnectAuthorizedRequest<RequestContext>
  ): boolean | Promise<boolean>;
  createRequestContext?(
    request: CmdProtoConnectRequestInfo
  ): RequestContext | Promise<RequestContext>;
  interceptors?: Interceptor[];
  readMaxBytes?: number;
  writeMaxBytes?: number;
  maxTimeoutMs?: number;
  requireConnectProtocolHeader?: boolean;
  singletonHeaders?: Iterable<string>;
}

export interface CmdProtoConnectClientRequest {
  methodName: string;
  request: CommandRequestJson;
}

export type CmdProtoConnectFetch = (request: Request) => Promise<Response>;

export interface CmdProtoConnectTransportOptions {
  remoteMethods: Iterable<string>;
  baseUrl: string | (() => string | Promise<string>);
  headers?:
    | HeadersInit
    | ((request: CmdProtoConnectClientRequest) => HeadersInit | Promise<HeadersInit>);
  fetch?: CmdProtoConnectFetch;
  interceptors?: Interceptor[];
  timeoutMs?: number;
}

export function registerCmdProtoConnectRoutes<RequestContext = undefined>(
  router: ConnectRouter,
  options: CmdProtoConnectServerOptions<RequestContext>
): void {
  const allowMethods = [...new Set(options.allowMethods)];
  const routeOptions = {
    connect: true,
    grpc: false,
    grpcWeb: false,
    interceptors: options.interceptors ?? [],
    readMaxBytes: positiveByteLimit(
      options.readMaxBytes,
      DEFAULT_MAX_MESSAGE_BYTES,
      "readMaxBytes"
    ),
    writeMaxBytes: positiveByteLimit(
      options.writeMaxBytes,
      DEFAULT_MAX_MESSAGE_BYTES,
      "writeMaxBytes"
    ),
    requireConnectProtocolHeader: options.requireConnectProtocolHeader ?? true,
    jsonOptions: {
      ignoreUnknownFields: false,
      registry: options.runtime.schema.registry
    },
    ...(options.maxTimeoutMs === undefined
      ? {}
      : { maxTimeoutMs: positiveInteger(options.maxTimeoutMs, "maxTimeoutMs") })
  };

  for (const methodName of allowMethods) {
    const command = options.runtime.commandByMethod.get(methodName);
    if (!command) {
      throw new CmdProtoError(
        "METHOD_NOT_FOUND",
        `Connect allowlist contains unknown command method: ${methodName}`
      );
    }
    if (command.method.methodKind !== "unary") {
      throw new CmdProtoError(
        "UNIMPLEMENTED",
        `Connect only supports unary command methods: ${methodName}`
      );
    }
    if (!options.runtime.handlers[methodName]) {
      throw new CmdProtoError(
        "HANDLER_NOT_FOUND",
        `No handler registered for allowlisted Connect method: ${methodName}`
      );
    }

    const method = command.method as DescMethodUnary;
    router.rpc(
      method,
      async (request, context) => {
        const requestInfo = connectRequestInfo(
          methodName,
          method,
          request,
          context
        );
        try {
          const requestContext = options.createRequestContext
            ? await options.createRequestContext(requestInfo)
            : (undefined as RequestContext);
          const authorizedRequest = { ...requestInfo, requestContext };
          if (!await options.authorize(authorizedRequest)) {
            throw new ConnectError("permission denied", Code.PermissionDenied);
          }
          return await options.runtime.dispatchProtobuf(
            methodName,
            request,
            { requestContext }
          );
        } catch (error) {
          throw cmdProtoErrorToConnect(error);
        }
      },
      routeOptions
    );
  }
}

export function createCmdProtoConnectTransport(
  options: CmdProtoConnectTransportOptions
): CommandTransport {
  const remoteMethods = new Set(options.remoteMethods);

  return {
    async dispatch(runtime, request) {
      if (!remoteMethods.has(request.method)) {
        return runtime.dispatch(request);
      }

      const prepared = runtime.prepareProtobufRequest(request);
      const baseUrl = await resolveBaseUrl(options.baseUrl);
      const headers = typeof options.headers === "function"
        ? await options.headers({ methodName: request.method, request: prepared.request })
        : options.headers;
      const transport = createConnectTransport({
        baseUrl,
        useBinaryFormat: true,
        useHttpGet: false,
        interceptors: options.interceptors,
        defaultTimeoutMs: options.timeoutMs,
        ...(options.fetch
          ? { fetch: fetchAdapter(options.fetch) }
          : {})
      });

      let response;
      try {
        response = await transport.unary(
          prepared.method,
          undefined,
          options.timeoutMs,
          headers,
          prepared.message
        );
      } catch (error) {
        throw connectErrorToCmdProto(error);
      }
      return runtime.decodeProtobufResponse(request.method, response.message);
    }
  };
}

export function cmdProtoErrorToConnect(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    // An explicit ConnectError is the caller's intentional public wire contract.
    return error;
  }
  if (error instanceof CmdProtoError) {
    const expose = isPublicCmdProtoError(error);
    return new ConnectError(
      expose ? error.message : "internal error",
      connectCodeForCmdProto(error.code),
      undefined,
      !expose || error.details === undefined
        ? undefined
        : [{ desc: ValueSchema, value: fromJson(ValueSchema, error.details) }],
      error
    );
  }
  return new ConnectError(
    "internal error",
    Code.Internal,
    undefined,
    undefined,
    error
  );
}

export function connectErrorToCmdProto(error: unknown): CmdProtoError {
  const connectError = ConnectError.from(error, Code.Unknown);
  const details = connectError.findDetails(ValueSchema)[0];
  return new CmdProtoError(
    cmdProtoCodeForConnect(connectError.code),
    connectError.rawMessage || "Connect request failed",
    details === undefined ? undefined : toJson(ValueSchema, details) as JsonValue
  );
}

function connectRequestInfo(
  methodName: string,
  descriptor: DescMethodUnary,
  request: MessageShape<DescMethodUnary["input"]>,
  context: ConnectHandlerContext
): CmdProtoConnectRequestInfo {
  return {
    methodName,
    descriptor,
    request,
    requestHeader: context.requestHeader,
    requestMethod: context.requestMethod,
    responseHeader: context.responseHeader,
    responseTrailer: context.responseTrailer,
    signal: context.signal,
    timeoutMs: context.timeoutMs(),
    url: context.url
  };
}

function connectCodeForCmdProto(code: string): Code {
  return CMDPROTO_TO_CONNECT_CODE[code] ?? Code.Unknown;
}

function cmdProtoCodeForConnect(code: Code): string {
  return CONNECT_TO_CMDPROTO_CODE[code] ?? "UNKNOWN";
}

function isPublicCmdProtoError(error: CmdProtoError): boolean {
  const mapped = CMDPROTO_TO_CONNECT_CODE[error.code];
  return mapped !== undefined && mapped !== Code.Internal && mapped !== Code.Unknown;
}

function positiveByteLimit(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  return value === undefined ? fallback : positiveInteger(value, name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

async function resolveBaseUrl(
  value: string | (() => string | Promise<string>)
): Promise<string> {
  const resolved = typeof value === "function" ? await value() : value;
  if (!resolved.trim()) {
    throw new CmdProtoError("INVALID_ARGUMENT", "Connect baseUrl must not be empty");
  }
  return resolved.trim();
}

function fetchAdapter(fetchHandler: CmdProtoConnectFetch): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return fetchHandler(request);
  };
}

const CMDPROTO_TO_CONNECT_CODE: Readonly<Record<string, Code>> = {
  ABORTED: Code.Aborted,
  ALREADY_EXISTS: Code.AlreadyExists,
  CANCELED: Code.Canceled,
  DATA_LOSS: Code.DataLoss,
  DEADLINE_EXCEEDED: Code.DeadlineExceeded,
  FAILED_PRECONDITION: Code.FailedPrecondition,
  HANDLER_NOT_FOUND: Code.Unimplemented,
  INTERNAL: Code.Internal,
  INVALID_ARGUMENT: Code.InvalidArgument,
  INVALID_REQUEST: Code.InvalidArgument,
  INVALID_RESULT: Code.Internal,
  METHOD_NOT_FOUND: Code.Unimplemented,
  NOT_FOUND: Code.NotFound,
  OUT_OF_RANGE: Code.OutOfRange,
  PERMISSION_DENIED: Code.PermissionDenied,
  RESOURCE_EXHAUSTED: Code.ResourceExhausted,
  UNAUTHENTICATED: Code.Unauthenticated,
  UNAVAILABLE: Code.Unavailable,
  UNIMPLEMENTED: Code.Unimplemented,
  UNKNOWN: Code.Unknown
};

const CONNECT_TO_CMDPROTO_CODE: Readonly<Record<number, string>> = {
  [Code.Aborted]: "ABORTED",
  [Code.AlreadyExists]: "ALREADY_EXISTS",
  [Code.Canceled]: "CANCELED",
  [Code.DataLoss]: "DATA_LOSS",
  [Code.DeadlineExceeded]: "DEADLINE_EXCEEDED",
  [Code.FailedPrecondition]: "FAILED_PRECONDITION",
  [Code.Internal]: "INTERNAL",
  [Code.InvalidArgument]: "INVALID_ARGUMENT",
  [Code.NotFound]: "NOT_FOUND",
  [Code.OutOfRange]: "OUT_OF_RANGE",
  [Code.PermissionDenied]: "PERMISSION_DENIED",
  [Code.ResourceExhausted]: "RESOURCE_EXHAUSTED",
  [Code.Unauthenticated]: "UNAUTHENTICATED",
  [Code.Unavailable]: "UNAVAILABLE",
  [Code.Unimplemented]: "UNIMPLEMENTED",
  [Code.Unknown]: "UNKNOWN"
};
