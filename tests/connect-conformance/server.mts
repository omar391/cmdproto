import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { create, createRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import {
  createCmdProtoBunHandler,
  createCmdProtoBunNodeHandler
} from "../../connect/bun.js";
import type {
  CmdProtoConnectFetch,
  CmdProtoConnectRequestInfo
} from "../../connect/core.js";
import { createCmdProtoFetchHandler } from "../../connect/fetch.js";
import { createCmdProtoNodeHandler } from "../../connect/node.js";
import type { CmdProtoRuntime } from "../../runtimes/runtime.js";

const connectEsRoot = process.env.CMDPROTO_CONNECT_ES_ROOT;
if (!connectEsRoot) {
  throw new Error("CMDPROTO_CONNECT_ES_ROOT is required");
}
const conformanceSource = join(
  connectEsRoot,
  "packages/connect-conformance/src"
);
const sourceUrl = (path: string) => pathToFileURL(join(conformanceSource, path)).href;
const [routesModule, protocol, serverCompat, service] = await Promise.all([
  import(sourceUrl("routes.ts")),
  import(sourceUrl("protocol.ts")),
  import(sourceUrl("gen/connectrpc/conformance/v1/server_compat_pb.ts")),
  import(sourceUrl("gen/connectrpc/conformance/v1/service_pb.ts"))
]);

const adapter = process.argv[2] ?? "node";
const config = fromBinary(
  serverCompat.ServerCompatRequestSchema,
  readFileSync(process.stdin.fd).subarray(4)
);
if (config.useTls || config.httpVersion !== 1) {
  throw new Error("cmdproto conformance harness supports plaintext HTTP/1 only");
}

let implementations: Record<string, (...args: unknown[]) => unknown> | undefined;
routesModule.default({
  service(_service: unknown, handlers: Record<string, (...args: unknown[]) => unknown>) {
    implementations = handlers;
  }
} as never);
if (!implementations) {
  throw new Error("failed to capture official conformance handlers");
}

const methods = service.ConformanceService.methods.filter((method: { name: string }) =>
  method.name === "Unary" || method.name === "IdempotentUnary"
);
const methodNames = methods.map((method: { parent: { typeName: string }; name: string }) =>
  `${method.parent.typeName}.${method.name}`
);
const runtime = {
  schema: {
    registry: createRegistry(service.file_connectrpc_conformance_v1_service)
  },
  commandByMethod: new Map(methods.map((method: { parent: { typeName: string }; name: string }) => [
    `${method.parent.typeName}.${method.name}`,
    { method }
  ])),
  handlers: Object.fromEntries(methodNames.map((name: string) => [name, () => undefined])),
  async dispatchProtobuf(
    methodName: string,
    request: unknown,
    options: { requestContext?: unknown }
  ) {
    const info = options.requestContext as CmdProtoConnectRequestInfo;
    const method = methods.find((candidate: { parent: { typeName: string }; name: string }) =>
      `${candidate.parent.typeName}.${candidate.name}` === methodName
    );
    if (!method) {
      throw new Error(`unknown test method ${methodName}`);
    }
    const key = method.name === "Unary" ? "unary" : "idempotentUnary";
    const handlerContext = {
      method,
      service: method.parent,
      signal: info.signal,
      timeoutMs: () => info.timeoutMs,
      requestMethod: info.requestMethod,
      requestHeader: info.requestHeader,
      responseHeader: info.responseHeader,
      responseTrailer: info.responseTrailer,
      protocolName: "connect",
      values: { get: () => undefined, set: () => undefined, delete: () => false },
      url: info.url
    } as unknown as HandlerContext;
    return implementations?.[key]?.(request, handlerContext);
  }
} as unknown as CmdProtoRuntime;

const options = {
  runtime,
  allowMethods: methodNames,
  authorize: () => true,
  createRequestContext: (info: CmdProtoConnectRequestInfo) => info,
  readMaxBytes: config.messageReceiveLimit || 1024 * 1024,
  requireConnectProtocolHeader: true
};

process.on("SIGTERM", () => process.exit(0));

if (adapter === "bun-fetch") {
  if (typeof Bun === "undefined") {
    throw new Error("bun-fetch adapter must run under Bun");
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createCmdProtoBunHandler(options)
  });
  announce(server.port);
} else {
  const server = adapter === "node" || adapter === "bun-node"
    ? createServer(
      adapter === "bun-node"
        ? createCmdProtoBunNodeHandler(options)
        : createCmdProtoNodeHandler(options)
    )
    : createServer(nodeFetchBridge(createCmdProtoFetchHandler(options)));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not expose an address");
    }
    announce(address.port);
  });
}

function announce(port: number): void {
  const response = create(serverCompat.ServerCompatResponseSchema, {
    host: "127.0.0.1",
    port
  });
  process.stdout.write(protocol.writeSizeDelimitedBuffer(
    toBinary(serverCompat.ServerCompatResponseSchema, response)
  ));
}

function nodeFetchBridge(handler: CmdProtoConnectFetch) {
  return async (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse
  ) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks);
    const host = request.headers.host ?? "127.0.0.1";
    const fetchResponse = await handler(new Request(
      `http://${host}${request.url ?? "/"}`,
      {
        method: request.method,
        headers: request.headers as HeadersInit,
        ...(body.byteLength === 0 ? {} : { body })
      }
    ));
    response.writeHead(
      fetchResponse.status,
      Object.fromEntries(fetchResponse.headers.entries())
    );
    response.end(Buffer.from(await fetchResponse.arrayBuffer()));
  };
}
