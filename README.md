# cmdproto

`cmdproto` is a proto-first command ABI toolkit for tool-shaped apps.

App authors describe commands in protobuf, attach CLI bindings and examples as
options, and get one descriptor-led surface for:

- human commands
- per-command help
- machine JSON execution

## Why

AI apps need tools, and tool calls need contracts.

`cmdproto` keeps that contract in core protobuf so one schema can explain:

- what a tool is called
- how a human runs it
- what JSON payload an assistant should send
- what minimal example proves the call shape

That same command ABI can later back other adapters too:

- gRPC transport for remote callers
- MCP or JSON-RPC 2.0 transport for assistant integration
- live event streaming over stdio, gRPC, or WebSocket

Those adapters are future work, not implemented in V1. Today V1 is a strict
manifest-driven CLI and JSON execution surface backed by protobuf descriptors.

## V1 Shape

- Human CLI: `app greet Ada -s`
- Command help: `app greet --help`
- Structured help: `app greet --help --json`
- Machine CLI: `app cmdproto execute greet --json '{"name":"Ada","shout":true}'`

Default structured help is intentionally lean and uses the manifest app name:

```json
{"payload_schema":{"name":{"type":"string","help":"Name to greet."},"shout":{"type":"boolean","help":"Uppercase the greeting."}},"examples":[{"cmd":"greeter cmdproto execute greet --json '{\"name\":\"Ada\",\"shout\":true}'","description":"Render a loud greeting."}]}
```

`--help` carries the richer human-facing details: the fully-qualified RPC name,
CLI/JSON parameter mapping, input/output type names, and both human and machine
examples.

There is no separate `describe` command in V1. Structured help hangs off the
same per-command `--help` surface that humans use.

## Repo Layout

- `proto/` contains `cmdproto`'s own option schema.
- `runtimes/runtime.ts` is the minimal TypeScript runtime implementation.
- `examples/greeter/proto/` is a separate app proto, built as its own schema
  artifact.

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
npm run schema:build:greeter
```

3. `buf lint` runs both Buf's built-in lint rules and the local `cmdproto`
   check plugin. That catches duplicate command paths, alias collisions,
   duplicate flags, reserved meta flags like `--help` and `--json`, invalid
   positional layouts, prefix-shadowing, and missing or malformed command
   examples during schema authoring.
4. Buf compiles your `.proto` files into `schema.binpb`, which is a protobuf
   `FileDescriptorSet`, and the shared Go compiler emits a normalized
   `runtime.binpb` manifest beside it.
5. `cmdproto` loads both artifacts at runtime. The manifest drives command
   routing, help output, and human CLI parsing; the descriptor set is only used
   for protobuf JSON validation and type reflection.
6. Register handlers and use the app through human commands, `--help`, or
   `cmdproto execute <path> --json`.

`schema.binpb` and `runtime.binpb` are the compiled runtime artifacts that
`cmdproto` consumes. We do not read raw `.proto` text in the app process.
`dist/` is only the default location, not a hard requirement; for example,
`runMain({ handlers, schemaPath: "/some/other/schema.binpb", manifestPath: "/some/other/runtime.binpb" })`
works too.

In this repo specifically:

- `npm run schema:build` builds the library's own `proto/` schema to `dist/schema.binpb` and `dist/runtime.binpb`.
- `npm run schema:build:greeter` builds the example app schema to `examples/greeter/dist/schema.binpb` and `examples/greeter/dist/runtime.binpb`.
- `npm run example:greeter -- greet Ada -s` uses the example-owned schema file, not the root one.
- `buf lint` requires Go locally because the repo-local plugin launcher runs `go run ./tools/buf-plugin-cmdproto/...`.

The transport roadmap is tracked in [future_plan.md](/Volumes/Projects/business/AstronLab/omar391/cmdproto/future_plan.md).

## Development

```sh
npm install
npm run check
npm run schema:build:greeter
npm run example:greeter -- greet Ada -s
npm run example:greeter -- greet --help
npm run example:greeter -- greet --help --json
npm run example:greeter -- cmdproto execute greet --json '{"name":"Ada","shout":true}'
```
