import {
  connectNodeAdapter,
  universalRequestFromNodeRequest,
  universalResponseToNodeResponse
} from "@connectrpc/connect-node";
import {
  type CmdProtoConnectServerOptions
} from "./core.js";
import { createCmdProtoUniversalHandlers } from "./universal.js";

export function createCmdProtoNodeHandler<RequestContext = undefined>(
  options: CmdProtoConnectServerOptions<RequestContext>
): ReturnType<typeof connectNodeAdapter> {
  const handlers = createCmdProtoUniversalHandlers(options);
  const singletonHeaders = new Set([
    "authorization",
    "proxy-authorization",
    "host",
    "origin",
    "content-type",
    "content-encoding",
    "connect-protocol-version",
    "connect-timeout-ms",
    ...[...(options.singletonHeaders ?? [])].map((name) => name.toLowerCase())
  ]);
  const nodeHandler: ReturnType<typeof connectNodeAdapter> = (request, response) => {
    void (async () => {
      const duplicate = findDuplicateHeader(request, singletonHeaders);
      if (duplicate) {
        const body = JSON.stringify({
          code: "invalid_argument",
          message: `duplicate header is not allowed: ${duplicate}`
        });
        response.writeHead(400, {
          "content-length": String(Buffer.byteLength(body)),
          "content-type": "application/json"
        });
        response.end(body);
        return;
      }
      const converted = universalRequestFromNodeRequest(
        request,
        response,
        undefined,
        undefined
      );
      const universalRequest = {
        ...converted,
        header: headersFromRaw(request, converted.header)
      };
      const handler = handlers.get(new URL(universalRequest.url).pathname);
      const universalResponse = handler
        ? await handler(universalRequest)
        : { status: 404 };
      await universalResponseToNodeResponse(universalResponse, response);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        if ("destroy" in response && typeof response.destroy === "function") {
          response.destroy(error instanceof Error ? error : undefined);
        } else {
          response.end();
        }
        return;
      }

      const body = JSON.stringify({ code: "internal", message: "internal error" });
      response.writeHead(500, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json"
      });
      response.end(body);
    });
  };
  return nodeHandler;
}

interface RawHeaderRequest {
  rawHeaders: string[];
}

function headersFromRaw(request: RawHeaderRequest, fallback: Headers): Headers {
  if (request.rawHeaders.length === 0) {
    return fallback;
  }
  const headers = new Headers();
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value !== undefined && !name.startsWith(":")) {
      headers.append(name, value);
    }
  }
  return headers;
}

function findDuplicateHeader(
  request: RawHeaderRequest,
  singletonHeaders: ReadonlySet<string>
): string | undefined {
  const seen = new Set<string>();
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (!name || !singletonHeaders.has(name)) {
      continue;
    }
    if (seen.has(name)) {
      return name;
    }
    seen.add(name);
  }
  return undefined;
}
