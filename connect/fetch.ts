import { createFetchHandler } from "@connectrpc/connect/protocol";
import {
  type CmdProtoConnectFetch,
  type CmdProtoConnectServerOptions
} from "./core.js";
import { createCmdProtoUniversalHandlers } from "./universal.js";

export function createCmdProtoFetchHandler<RequestContext = undefined>(
  options: CmdProtoConnectServerOptions<RequestContext>
): CmdProtoConnectFetch {
  const handlers = new Map(
    [...createCmdProtoUniversalHandlers(options)].map(([path, handler]) => [
      path,
      createFetchHandler(handler)
    ])
  );

  return async (request) => {
    const handler = handlers.get(new URL(request.url).pathname);
    return handler
      ? handler(request)
      : new Response(null, { status: 404 });
  };
}
