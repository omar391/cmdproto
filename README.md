# cmdproto

`cmdproto` is a proto-first command ABI toolkit. App authors describe RPCs in
protobuf, annotate CLI bindings with custom options, and get one descriptor-led
surface for human commands, machine JSON invocation, and future transport
adapters.

V1 keeps the core ABI small:

- `service` + `rpc` stay the source of truth.
- `cmdproto/v1/options.proto` defines command-path and parameter bindings.
- Transport details are not part of the core proto ABI.

## V1 Shape

- Human CLI: `app greet Ada -s`
- Machine CLI: `app cmdproto invoke --json '{"method":"greeter.v1.GreeterService.SayHello","params":{"name":"Ada"}}'`
- Introspection: `app cmdproto methods list`

## Repo Layout

- `proto/` contains `cmdproto`'s own option schema.
- `examples/greeter/proto/` is a separate app proto, built as its own schema artifact.

## Authoring A New App

```proto
edition = "2024";

package fastbrowser.v1;

import "cmdproto/v1/options.proto";

service FastbrowserService {
  rpc SessionCreate(SessionCreateRequest) returns (SessionResult) {
    option (cmdproto.v1.command) = {
      path: "session create"
      alias: "session new"
      summary: "Create a browser session."
    };
  }
}

message SessionCreateRequest {
  string workflow_ref = 1 [
    (cmdproto.v1.param) = {
      positional: { index: 1 }
      help: "Workflow reference."
    }
  ];

  string profile_name = 2 [
    (cmdproto.v1.param) = {
      flag: {
        long: "profile"
        short: "p"
      }
      help: "Browser profile name."
    }
  ];
}

message SessionResult {
  string session_id = 1;
}
```

Minimal TypeScript bootstrap:

```ts
import { runMain, type HandlerMap } from "cmdproto";

const handlers: HandlerMap = {
  "fastbrowser.v1.FastbrowserService.SessionCreate"(params) {
    return {
      sessionId: `sess_${params.workflowRef}`
    };
  }
};

await runMain({ handlers });
```

## Lifecycle

1. Write your app proto and import `cmdproto/v1/options.proto`.
2. Build your app proto into a descriptor set, for example:

```sh
buf lint examples/greeter/proto
buf build examples/greeter/proto --as-file-descriptor-set -o examples/greeter/dist/schema.binpb
```

3. `buf lint` runs both Buf's built-in lint rules and the local `cmdproto`
   check plugin, so command-path, alias, flag, positional, and prefix-shadowing
   issues fail during schema authoring instead of only at runtime.
4. Buf compiles your `.proto` files into a `schema.binpb` descriptor artifact,
   which is a protobuf `FileDescriptorSet`.
5. `cmdproto` loads that descriptor set and uses the already-linted schema at
   runtime, while still re-validating defensively inside the TypeScript runtime.
6. Register handlers and invoke the app through human commands or
   `cmdproto invoke --json`.

`schema.binpb` is just the compiled schema artifact. It is the CLI/router
manifest that `cmdproto` actually consumes at runtime. We do not read raw
`.proto` text in the app process. `dist/` is only the default location, not a
hard requirement; `runMain({ handlers, schemaPath: "/some/other/schema.binpb" })`
works too.

The repo now ships a local Buf check plugin at `scripts/buf-plugin-cmdproto`.
That moves `cmdproto` schema validation into `buf lint`, so duplicate command
paths, alias collisions, duplicate flags, reserved `cmdproto` paths, invalid
positional layouts, and prefix-shadowing fail in the normal protobuf authoring
loop. The TypeScript runtime still validates the descriptor set as a fallback.

In this repo specifically:

- `npm run schema:build` builds the library's own `proto/` schema to `dist/schema.binpb`.
- `npm run schema:build:greeter` builds the example app schema to `examples/greeter/dist/schema.binpb`.
- `npm run example:greeter -- greet Ada -s` uses the example-owned schema file, not the root one.
- `buf lint` requires Go locally because the repo-local plugin launcher runs `go run ./tools/buf-plugin-cmdproto/...`.

## Development

```sh
npm install
npm run check
npm run schema:build:greeter
npm run example:greeter -- greet Ada -s
npm run example:greeter -- cmdproto methods describe greeter.v1.GreeterService.SayHello
```
