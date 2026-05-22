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
- what JSON an assistant should send
- what minimal example proves the call shape

That same command ABI can later back other adapters too:

- gRPC transport for remote callers
- MCP or JSON-RPC 2.0 transport for assistant integration
- live event streaming over stdio, gRPC, or WebSocket

Those adapters are future work, not implemented in V1. Today V1 is a strict
descriptor-driven CLI and JSON execution surface.

## V1 Shape

- Human CLI: `app greet Ada -s`
- Command help: `app greet --help`
- Structured help: `app greet --help --json`
- Verbose structured help: `app greet --help --json --verbose`
- Machine CLI: `app cmdproto execute --json '{"method":"greeter.v1.GreeterService.SayHello","params":{"name":"Ada","shout":true}}'`

Default structured help is intentionally lean:

```json
{
  "method": "greeter.v1.GreeterService.SayHello",
  "fields": {
    "name": {
      "positionalIndex": 1,
      "help": "Name to greet."
    },
    "shout": {
      "longFlag": "shout",
      "shortFlag": "s",
      "help": "Uppercase the greeting."
    }
  },
  "examples": [
    {
      "cmd": "greet Ada -s",
      "json": {
        "method": "greeter.v1.GreeterService.SayHello",
        "params": {
          "name": "Ada",
          "shout": true
        }
      }
    }
  ]
}
```

`--json --verbose` returns the richer descriptor-oriented view for callers that
want service, RPC, input/output type names, and the older field-array shape.

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
        request_json: "{\"method\":\"greeter.v1.GreeterService.SayHello\",\"params\":{\"name\":\"Ada\",\"shout\":true}}"
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
buf lint examples/greeter/proto
buf build examples/greeter/proto --as-file-descriptor-set -o examples/greeter/dist/schema.binpb
```

3. `buf lint` runs both Buf's built-in lint rules and the local `cmdproto`
   check plugin. That catches duplicate command paths, alias collisions,
   duplicate flags, reserved meta flags like `--help`, `--json`, and
   `--verbose`, invalid positional layouts, prefix-shadowing, and missing or
   malformed command examples during schema authoring.
4. Buf compiles your `.proto` files into `schema.binpb`, which is a protobuf
   `FileDescriptorSet`.
5. `cmdproto` loads that descriptor set at runtime. The main schema gate is
   still `buf lint`; the runtime re-validates live request and response JSON as
   a fail-closed safety net in case a descriptor artifact is stale, hand-built,
   or the caller/handler sends malformed data.
6. Register handlers and use the app through human commands, `--help`, or
   `cmdproto execute --json`.

`schema.binpb` is the compiled descriptor artifact that `cmdproto` consumes at
runtime. We do not read raw `.proto` text in the app process. `dist/` is only
the default location, not a hard requirement; for example,
`runMain({ handlers, schemaPath: "/some/other/schema.binpb" })` works too.

In this repo specifically:

- `npm run schema:build` builds the library's own `proto/` schema to `dist/schema.binpb`.
- `npm run schema:build:greeter` builds the example app schema to `examples/greeter/dist/schema.binpb`.
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
npm run example:greeter -- greet --help --json --verbose
npm run example:greeter -- cmdproto execute --json '{"method":"greeter.v1.GreeterService.SayHello","params":{"name":"Ada","shout":true}}'
```
