# Future Plan

This file only covers work that is not implemented in the current release.

## Current stance

- `cmdproto` is descriptor-plus-manifest driven.
- Execution is unary: one request in, one final response out.
- Per-command `--help` and `--help --json` are the public introspection
  surfaces.
- `cmdproto execjson <path> <json|@file|@->` is the machine execution entrypoint.
- Explicitly selected unary commands can use the opt-in Connect server and
  caller transport with Fetch, Bun, or Node hosting.

## Future adapters

The same command ABI should be reusable across multiple transports:

- stdio command execution and future long-lived local agent sessions
- gRPC transport for remote clients beyond the implemented unary Connect path
- MCP or JSON-RPC 2.0 transport for assistant integrations

The goal is to keep the descriptor set plus generated manifest small enough
that future adapters can sit around the same core rather than redefining the
tool contract.

## Future streaming

If we add live events later, they should stream on persistent transports rather
than being buffered into the unary response envelope.

Likely future shapes:

- framed stdio session mode
- gRPC streaming surface
- WebSocket event transport

Important rule: do not reintroduce buffered pseudo-streaming inside the unary
JSON response.

## Future caching

Persistent clients may eventually cache structured help by a schema hash so
they can skip re-fetching unchanged command metadata.

That is an optimization for long-lived clients, not a V1 requirement.
