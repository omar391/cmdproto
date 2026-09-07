import { spawn, type SpawnOptions } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CmdProtoError } from "../runtimes/errors.js";
import type { CmdProtoRuntime } from "../runtimes/runtime.js";
import {
  CMDPROTO_INTERNAL_CONNECT_ARG,
  type CmdProtoInternalServer
} from "../runtimes/runtime.js";
import {
  createCmdProtoNodeHandler
} from "./node.js";
import type {
  CmdProtoConnectServerOptions
} from "./core.js";

/** A consumer-owned capability projection returned by ensure-running. */
export type CmdProtoServerCapability = Readonly<Record<string, unknown>>;

export interface CmdProtoServerHandle {
  /** The listener's canonical base URL, when the host publishes one. */
  readonly baseUrl?: string;
  /** Resolves when the host listener has shut down. */
  readonly closed?: Promise<void>;
  readonly close?: () => Promise<void> | void;
}

/**
 * The only lifecycle seam a consumer needs to provide. Cmdproto owns the
 * canonical Connect route handler; the consumer mounts that handler into its
 * existing listener and supplies auth/context hooks through the shared
 * CmdProtoConnectServerOptions.
 */
export interface CmdProtoConnectMount {
  mount(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    runtime?: CmdProtoRuntime
  ): Promise<CmdProtoServerHandle> | CmdProtoServerHandle;
}

export type CmdProtoConnectServerOptionsWithoutRuntime<RequestContext = undefined> =
  Omit<CmdProtoConnectServerOptions<RequestContext>, "runtime"> & CmdProtoConnectMount;

/**
 * Lifecycle-only internal bootstrap for consumers whose service already owns
 * the listener and daemon process. `start` receives cmdproto's descriptor-led
 * runtime; `mount` remains available for consumers that directly host the
 * package-created Node handler.
 */
export interface CmdProtoInternalServerStartOptions {
  readonly start: (runtime: CmdProtoRuntime) => Promise<CmdProtoServerHandle> | CmdProtoServerHandle;
  readonly mount?: never;
}

export type CmdProtoInternalServerMountOptions<RequestContext = undefined> =
  CmdProtoConnectServerOptionsWithoutRuntime<RequestContext> & {
    readonly start?: never;
  };

export type CmdProtoInternalServerOptions<RequestContext = undefined> =
  | CmdProtoInternalServerStartOptions
  | CmdProtoInternalServerMountOptions<RequestContext>;

/** Start the generic cmdproto Connect handler on a consumer-owned listener. */
export async function startCmdProtoConnectServer<RequestContext = undefined>(
  options: CmdProtoConnectServerOptionsWithoutRuntime<RequestContext> & { runtime: CmdProtoRuntime }
): Promise<CmdProtoServerHandle> {
  const handler = createCmdProtoNodeHandler(options);
  // The runtime is exposed only to the consumer's mount seam so an existing
  // service can compose the package-owned handler with its own lifecycle.
  // The handler remains the sole transport entrypoint; passing the runtime is
  // additive and keeps the generic bootstrap descriptor-aware without making
  // consumers re-create it from paths.
  return options.mount(handler, options.runtime);
}

/**
 * Adapt a consumer's Connect lifecycle hooks to runMain's reserved internal
 * server mode. The returned callback is only invoked for the internal mode;
 * ordinary invocations remain CLI-first.
 */
export function createCmdProtoInternalServer<RequestContext = undefined>(
  options: CmdProtoInternalServerOptions<RequestContext>
): CmdProtoInternalServer {
  const callbacks = options as {
    readonly mount?: CmdProtoConnectMount["mount"];
    readonly start?: CmdProtoInternalServerStartOptions["start"];
  };
  if ((callbacks.start === undefined) === (callbacks.mount === undefined)) {
    throw new TypeError("cmdproto internal server requires exactly one start or mount callback");
  }

  return {
    async run(runtime: CmdProtoRuntime): Promise<void> {
      const handle = "start" in options && options.start !== undefined
        ? await options.start(runtime)
        : "mount" in options && options.mount !== undefined
          ? await startCmdProtoConnectServer({ ...options, runtime })
          : (() => { throw new TypeError("unreachable cmdproto internal server options"); })();
      if (handle.closed !== undefined) await handle.closed;
    }
  };
}

export interface EnsureCmdProtoServerOptions<Capability extends CmdProtoServerCapability = CmdProtoServerCapability> {
  /** Read the consumer's capability file or equivalent discovery source. */
  readonly readCapability: () => Promise<Capability | undefined> | Capability | undefined;
  /** Reject malformed/stale projections instead of treating them as ready. */
  readonly isUsable?: (capability: Capability) => boolean | Promise<boolean>;
  /** Stable lock identity for concurrent callers in this process. */
  readonly lockKey?: string;
  /** Executable to launch. Defaults to the current Node/Bun process. */
  readonly executable?: string;
  /** Additional executable arguments. The internal mode argument is appended. */
  readonly args?: readonly string[];
  readonly internalArg?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnOptions?: Omit<SpawnOptions, "stdio" | "detached">;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Test/host seam; production uses node:child_process spawn. */
  readonly spawn?: typeof spawn;
}

const DEFAULT_ENSURE_TIMEOUT_MS = 30_000;
const DEFAULT_ENSURE_POLL_MS = 50;
const ensureInFlight = new Map<string | object, Promise<CmdProtoServerCapability>>();

/**
 * Ensure a cmdproto service exists without adding a user-facing `serve`
 * command. If discovery is empty, the same executable is spawned in the
 * reserved internal mode and the capability is polled until it is published.
 */
export async function ensureCmdProtoServer<Capability extends CmdProtoServerCapability = CmdProtoServerCapability>(
  options: EnsureCmdProtoServerOptions<Capability>
): Promise<Capability> {
  const timeoutMs = boundedPositive(options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS, "timeoutMs");
  const pollMs = boundedPositive(options.pollMs ?? DEFAULT_ENSURE_POLL_MS, "pollMs");
  const lockIdentity = options.lockKey ?? options.readCapability;
  const existing = ensureInFlight.get(lockIdentity);
  if (existing) return existing as Promise<Capability>;

  const operation = ensureServer(options, timeoutMs, pollMs);
  ensureInFlight.set(lockIdentity, operation as Promise<CmdProtoServerCapability>);
  try {
    return await operation;
  } finally {
    if (ensureInFlight.get(lockIdentity) === operation) ensureInFlight.delete(lockIdentity);
  }
}

async function ensureServer<Capability extends CmdProtoServerCapability>(
  options: EnsureCmdProtoServerOptions<Capability>,
  timeoutMs: number,
  pollMs: number
): Promise<Capability> {
  const usable = options.isUsable ?? (() => true);
  const initial = await options.readCapability();
  if (initial !== undefined && await usable(initial)) return initial;

  const executable = options.executable ?? process.execPath;
  const args = [...(options.args ?? defaultExecutableArgs()), options.internalArg ?? CMDPROTO_INTERNAL_CONNECT_ARG];
  let child;
  try {
    child = (options.spawn ?? spawn)(executable, args, {
      ...options.spawnOptions,
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      detached: true,
      stdio: "ignore"
    });
  } catch (error) {
    throw new CmdProtoError("DAEMON_UNAVAILABLE", `Could not start the cmdproto internal server: ${errorMessage(error)}`);
  }
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let childFailure: { readonly error: Error; readonly failAt: number } | undefined;
  const onError = (error: Error): void => {
    childFailure = { error, failAt: Date.now() };
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (childFailure?.failAt === undefined || childFailure.failAt > Date.now()) {
      // A non-zero exit can be a process-level startup-lock loser. The caller's
      // configured deadline is the only safe bound when another process may
      // still publish; clean and signaled exits are unambiguous failures.
      const mayHaveLostRace = signal === null && code !== null && code !== 0;
      childFailure = {
        error: new Error(`cmdproto internal server exited before publishing capability (${signal ?? code ?? "unknown"})`),
        failAt: mayHaveLostRace ? deadline : Date.now()
      };
    }
  };
  child.once("error", onError);
  child.once("exit", onExit);
  try {
    while (true) {
      const capability = await options.readCapability();
      if (capability !== undefined && await usable(capability)) return capability;

      const now = Date.now();
      if (childFailure && (now >= childFailure.failAt || now >= deadline)) {
        throw new CmdProtoError("DAEMON_UNAVAILABLE", childFailure.error.message);
      }
      if (now >= deadline) break;

      const nextBoundary = childFailure
        ? Math.min(deadline, childFailure.failAt)
        : deadline;
      await delay(Math.min(pollMs, Math.max(1, nextBoundary - now)));
    }
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
  throw new CmdProtoError("DEADLINE_EXCEEDED", "Timed out waiting for the cmdproto Connect capability.");
}

function defaultExecutableArgs(): string[] {
  const entry = process.argv[1];
  if (!entry) throw new CmdProtoError("INVALID_ARGUMENT", "Cannot infer the current executable entrypoint for cmdproto bootstrap.");
  return [entry];
}

function boundedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
