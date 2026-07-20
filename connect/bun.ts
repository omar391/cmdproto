import {
  createCmdProtoFetchHandler
} from "./fetch.js";
import { createCmdProtoNodeHandler } from "./node.js";
import type {
  CmdProtoConnectFetch,
  CmdProtoConnectServerOptions
} from "./core.js";

/**
 * @deprecated Native Bun.serve requests lose duplicate non-cookie headers.
 * Use createCmdProtoBunNodeHandler() for production control planes.
 */
export function createCmdProtoBunHandler<RequestContext = undefined>(
  options: CmdProtoConnectServerOptions<RequestContext>
): CmdProtoConnectFetch {
  return createCmdProtoFetchHandler(options);
}

/**
 * Bun's node:http compatibility layer preserves raw duplicate headers, unlike
 * Bun.serve's Fetch Request. Prefer this adapter when header fidelity matters.
 */
export function createCmdProtoBunNodeHandler<RequestContext = undefined>(
  options: CmdProtoConnectServerOptions<RequestContext>
): ReturnType<typeof createCmdProtoNodeHandler<RequestContext>> {
  return createCmdProtoNodeHandler(options);
}
