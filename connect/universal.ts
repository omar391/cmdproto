import { fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createConnectRouter } from "@connectrpc/connect";
import {
  readAllBytes,
  type UniversalHandler,
  type UniversalServerRequest,
  type UniversalServerResponse
} from "@connectrpc/connect/protocol";
import {
  codeToHttpStatus,
  codeToString
} from "@connectrpc/connect/protocol-connect";
import {
  registerCmdProtoConnectRoutes,
  type CmdProtoConnectServerOptions
} from "./core.js";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export function createCmdProtoUniversalHandlers<RequestContext = undefined>(
  options: CmdProtoConnectServerOptions<RequestContext>
): Map<string, UniversalHandler> {
  const router = createConnectRouter({
    connect: true,
    grpc: false,
    grpcWeb: false
  });
  registerCmdProtoConnectRoutes(router, options);
  const readMaxBytes = options.readMaxBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  return new Map(
    router.handlers.map((handler) => [
      handler.requestPath,
      validateBinaryRequest(handler, readMaxBytes)
    ])
  );
}

function validateBinaryRequest(
  handler: UniversalHandler,
  readMaxBytes: number
): UniversalHandler {
  const validated = async (
    request: UniversalServerRequest
  ): Promise<UniversalServerResponse> => {
    if (!shouldValidateBinaryRequest(request)) {
      return handler(request);
    }

    try {
      const bytes = await readAllBytes(
        request.body,
        readMaxBytes,
        request.header.get("content-length")
      );
      try {
        fromBinary(handler.method.input, bytes);
      } catch (error) {
        return connectErrorResponse(
          new ConnectError(
            "invalid Protobuf request",
            Code.InvalidArgument,
            undefined,
            undefined,
            error
          )
        );
      }
      return handler({ ...request, body: singleChunk(bytes) });
    } catch (error) {
      return connectErrorResponse(ConnectError.from(error, Code.InvalidArgument));
    }
  };

  return Object.assign(validated, {
    protocolNames: handler.protocolNames,
    service: handler.service,
    method: handler.method,
    requestPath: handler.requestPath,
    allowedMethods: handler.allowedMethods,
    supportedContentType: handler.supportedContentType
  });
}

function shouldValidateBinaryRequest(request: UniversalServerRequest): request is UniversalServerRequest & {
  body: AsyncIterable<Uint8Array>;
} {
  const body = request.body;
  const contentType = request.header.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const contentEncoding = request.header.get("content-encoding")?.toLowerCase();
  return request.method === "POST" &&
    contentType === "application/proto" &&
    (contentEncoding === undefined || contentEncoding === "identity") &&
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body;
}

function connectErrorResponse(error: ConnectError): UniversalServerResponse {
  const body = new TextEncoder().encode(JSON.stringify({
    code: codeToString(error.code),
    ...(error.rawMessage ? { message: error.rawMessage } : {})
  }));
  return {
    status: codeToHttpStatus(error.code),
    header: new Headers({
      "content-length": String(body.byteLength),
      "content-type": "application/json"
    }),
    body: singleChunk(body)
  };
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
