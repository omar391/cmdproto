# cmdproto

`cmdproto` is a proto-first command ABI toolkit for tool-shaped apps.

App authors describe commands in protobuf, attach CLI bindings and examples as
options, and get one descriptor-led surface for:

- human commands
- per-command help
- machine JSON execution
- a unary Connect control plane for selected commands with package-owned
  internal bootstrap and on-demand ensure-running support

## Why

AI apps need tools, and tool calls need contracts.

`cmdproto` keeps that contract in core protobuf so one schema can explain:

- what a tool is called
- how a human runs it
- what JSON payload an assistant should send
- what minimal example proves the call shape

The same command ABI can also back other adapters:

- unary Connect for explicit remote commands (implemented)
- MCP or JSON-RPC 2.0 transport for assistant integration
- live event streaming over stdio, gRPC, or WebSocket

MCP, JSON-RPC, gRPC, and streaming adapters remain future work. The Connect
surface is deliberately unary-only and uses the same manifest, validation,
handler, error, CLI, and `execjson` paths as local execution.

## V1 Shape

- Human CLI: `app greet Ada -s`
- Command help: `app greet --help`
- Structured help: `app greet --help --json`
- Machine CLI: `app cmdproto execjson greet '{"name":"Ada","shout":true}'`

Default structured help is intentionally lean and uses the manifest app name:

```json
{"payload_schema":{"name":{"type":"string","help":"Name to greet."},"shout":{"type":"boolean","help":"Uppercase the greeting."}},"examples":[{"cmd":"greeter cmdproto execjson greet '{\"name\":\"Ada\",\"shout\":true}'","description":"Render a loud greeting."}]}
```

`--help` carries the richer human-facing details: the fully-qualified RPC name,
CLI/JSON parameter mapping, input/output type names, and both human and machine
examples.

There is no separate `describe` command in V1. Structured help hangs off the
same per-command `--help` surface that humans use.

## Repo Layout

- `proto/` contains `cmdproto`'s own option schema.
- `runtimes/runtime.ts` is the minimal TypeScript runtime implementation.
- `connect/` contains unary Connect registration, caller transport, Fetch, Bun,
  and Node host adapters, plus the package-owned dual-mode bootstrap.
- `examples/greeter/proto/` is a separate app proto, built as its own schema
  artifact.

## As A Dependency

A consumer can install this repo directly as a git dependency and import the
runtime as `cmdproto`.

For a local sibling consumer during development, a saved dependency like
`"cmdproto": "file:../.."` is usually the simplest path.

For a fresh repo setup from git, a direct install like this works too:

```sh
npm install "cmdproto@git+https://github.com/omar391/cmdproto.git"
```

After install, run:

```sh
cmdproto init
```

That bootstrap step creates a deterministic starter layout in the consumer repo:

- `buf.gen.yaml`
- `buf.yaml` by default
- `proto/.../*.proto`
- `package.json` scripts:
  - `cmdproto:gen`
  - `cmdproto:schema`

If the consumer repo is TypeScript, run:

```sh
cmdproto init --runtime ts
```

That also creates:

- `src/cmdproto/app.mts`
- `tsconfig.json` when missing
- `package.json` script:
  - `cmdproto:run`

To add an opt-in Fetch-compatible Connect handler template, run:

```sh
cmdproto init --runtime ts --connect
```

This also creates `src/cmdproto/connect.mts`. It does not bind a listener or
choose authentication, TLS, ports, or process lifecycle for the consumer.

`cmdproto-buf-plugin` and the internal `cmdproto-runtime-manifest` helper are
shipped as package-contained WASM-backed commands. Normal consumer workflows
should use `cmdproto build`, which wraps the common Buf generate/lint/build plus
runtime-manifest flow. Consumer machines do not need Go installed for schema
build and lint.

## Authoring A New App

```proto
edition = "2024";

package greeter.v1;

import "cmdproto/v1/options.proto";

service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {
    option (cmdproto.v1.command) = {
      path: "greet"
      summary: "Render a greeting."
      alias: "hello"
      example: {
        command: "greet Ada -s"
        description: "Render a loud greeting."
        request_json: "{\"name\":\"Ada\",\"shout\":true}"
      }
    };
  }
}

message SayHelloRequest {
  string name = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
      help: "Name to greet."
    }
  ];

  bool shout = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "shout"
        short: "s"
      }
      help: "Uppercase the greeting."
    }
  ];
}

message SayHelloResponse {
  string message = 1;
}
```

Minimal TypeScript bootstrap:

```ts
import { runMain, type HandlerMap } from "cmdproto";

const handlers: HandlerMap = {
  "greeter.v1.GreeterService.SayHello"(params) {
    const message = `Hello, ${String(params.name ?? "")}!`;
    return {
      message: params.shout ? message.toUpperCase() : message
    };
  }
};

await runMain({ handlers });
```

## Lifecycle

1. Write your app proto and import `cmdproto/v1/options.proto`.
2. Lint and build a descriptor set, for example:

```sh
npm run cmdproto:schema
```

3. `buf lint` runs both Buf's built-in lint rules and the local `cmdproto`
   check plugin. That catches duplicate command paths, alias collisions,
   duplicate flags, reserved meta flags like `--help` and `--json`, invalid
   positional layouts, prefix-shadowing, and missing or malformed command
   examples during schema authoring.
4. Buf compiles your `.proto` files into `schema.binpb`, which is a protobuf
   `FileDescriptorSet`, and the shared compiler emits a normalized
   `runtime.binpb` manifest beside it.
5. `cmdproto` loads both artifacts at runtime. The manifest drives command
   routing, help output, and human CLI parsing; the descriptor set is only used
   for protobuf JSON validation and type reflection.
6. Register handlers and use the app through human commands, `--help`, or
   `cmdproto execjson <path> <json|@file|@->`.

`schema.binpb` and `runtime.binpb` are the compiled runtime artifacts that
`cmdproto` consumes. We do not read raw `.proto` text in the app process.
`dist/` is only the default location, not a hard requirement; for example,
`runMain({ handlers, schemaPath: "/some/other/schema.binpb", manifestPath: "/some/other/runtime.binpb" })`
works too.

## Unary Connect Control Plane

Connect support is opt-in per consumer, but the server bootstrap is owned by
cmdproto. A consumer provides an explicit fully-qualified method allowlist, an
authorization callback, and one mount/lifecycle hook for its existing listener.
An empty allowlist exposes no routes, and cmdproto never exposes every
annotated command automatically.

```ts
import { createServer } from "node:http";
import { createCmdProtoBunNodeHandler } from "cmdproto/connect/bun";
import { createAppRuntime, METHOD_NAME } from "./src/cmdproto/app.mjs";

const connect = createCmdProtoBunNodeHandler({
  runtime: createAppRuntime(),
  allowMethods: [METHOD_NAME],
  singletonHeaders: ["x-capability"],
  createRequestContext(request) {
    return { capability: request.requestHeader.get("x-capability") };
  },
  authorize(request) {
    return request.requestContext.capability === process.env.CONTROL_CAPABILITY;
  }
});

const server = createServer(connect);
// The consumer may attach server.on("upgrade", ...) on this same authority.
server.listen(3000, "127.0.0.1");
```

`createCmdProtoBunNodeHandler()` is the production Bun choice when raw header
fidelity matters. It runs under Bun's `node:http` compatibility layer, rejects
duplicate auth, authority, origin, and protocol singleton headers before
authorization, accepts custom singleton header names, and leaves WebSocket
upgrade ownership with the same consumer-created server.
`createCmdProtoNodeHandler()` provides the same request listener for Node.

`createCmdProtoFetchHandler()` returns a standard Fetch handler.
`createCmdProtoBunHandler()` is a native `Bun.serve` compatibility/development
surface only: Bun currently normalizes duplicate non-cookie headers before the
handler can inspect them. Do not use it for a production control plane; use the
Bun-node adapter so authentication and capability headers retain raw fidelity.

### CLI-first dual mode

Consumers can expose the same handler map through a reserved package-owned
internal mode without adding a public `serve` command:

```ts
import { runMain } from "cmdproto";
import { createCmdProtoInternalServer } from "cmdproto/connect/bootstrap";

await runMain({
  handlers,
  internalServer: createCmdProtoInternalServer({
    allowMethods: [METHOD_NAME],
    authorize,
    mount: (handler) => appListener.mountConnect(handler)
  })
});
```

Services which already own their listener can provide `start(runtime)` instead
of the mount configuration; the two lifecycle forms are mutually exclusive.
Cmdproto still performs the reserved-mode dispatch and passes the descriptor-led
runtime to that lifecycle hook.

Native clients call `ensureCmdProtoServer({ readCapability, ... })`. If the
capability is absent, cmdproto starts the same executable with the reserved
`--cmdproto-internal-connect` argument and waits for the consumer's capability
to appear. Calls with the same explicit `lockKey`, or the same capability-reader
function when no key is supplied, share one in-process startup. Independent
readers remain independent, and a concurrent child that exits non-zero keeps
polling for the winning process's capability through the configured timeout.
Clean exits, signals, and spawn errors remain prompt failures. Existing
operational `start` commands can remain, but generated clients never need to
shell to them.

Remote CLI and `execjson` calls select methods explicitly. Methods not in
`remoteMethods` continue to execute in process:

```ts
import { createCmdProtoConnectTransport } from "cmdproto/connect";

const transport = createCmdProtoConnectTransport({
  remoteMethods: [METHOD_NAME],
  baseUrl: "http://127.0.0.1:3000",
  headers: { authorization: `Bearer ${process.env.CONTROL_TOKEN}` }
});

await runMain({ handlers, transport });
```

The canonical route is descriptor-derived:
`/<protobuf.package.Service>/<Method>`. Binary protobuf is the normative wire
format. Strict Connect JSON is available for diagnostics. Responses are the
declared protobuf response directly, without cmdproto result/stdout envelopes.
Typed cmdproto failures map to canonical Connect codes; JSON-compatible details
round-trip as `google.protobuf.Value` error details. Internal and unknown custom
`CmdProtoError` messages/details and untyped exceptions are not exposed. A
handler or interceptor that deliberately throws `ConnectError` is declaring a
public wire error and its message, metadata, and details pass through; never put
secrets in an explicit `ConnectError`.

There are no REST aliases, listeners, TLS lifecycle, auth lifecycle, streaming
RPCs, or automatic all-command exposure in this package.

### Connect conformance scope

The official `connectrpc/conformance` runner passes all 88 applicable unary
Connect HTTP/1, identity-compression, protobuf/JSON server cases for the Node,
Fetch, and production Bun-node adapters. The native `Bun.serve` Fetch host
passes 81/88; its seven excluded cases require duplicate request-header
preservation that Bun 1.3.14 removes before handler entry (Basic unary proto and
JSON, Duplicate Metadata success/error proto and JSON, and Server Empty Requests).

Streaming, Connect GET, compression, TLS, HTTP/2+, gRPC, and gRPC-Web cases are
outside this intentionally unary adapter contract.

Reproduce the matrix with `npm run test:connect-conformance`. The checked
fixture pins both the official conformance runner and the matching Connect-ES
conformance service by commit, downloads them into ignored `tmp/`, and asserts
the expected case totals. This slower network/Go/Bun check is intentionally not
part of `npm run check`.

In this repo specifically:

- `npm run schema:build` builds the library's own `proto/` schema to `dist/schema.binpb` and `dist/runtime.binpb`.
- `npm run schema:build:greeter` builds the example app schema to `examples/greeter/dist/schema.binpb` and `examples/greeter/dist/runtime.binpb`.
- `npm run example:greeter -- greet Ada -s` uses the example-owned schema file, not the root one.
- consumer repos do not need Go locally; the package ships the build-time
  helpers as WASM-backed commands
- this repo still uses Go to rebuild `dist/wasm/` and to run `npm run test:plugin`

The remaining transport roadmap is tracked in [future_plan.md](future_plan.md).

## Development

```sh
npm install
npm run check
npm run schema:build:greeter
npm run example:greeter -- greet Ada -s
npm run example:greeter -- greet --help
npm run example:greeter -- greet --help --json
npm run example:greeter -- cmdproto execjson greet '{"name":"Ada","shout":true}'
npm --prefix examples/greeter install
npm --prefix examples/greeter run check
```
