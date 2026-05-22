# Future Plan

## Current V1 stance

- Keep `cmdproto` execution unary for now.
- Do not return `events` in the final JSON response envelope.
- Keep the core runtime transport-neutral and schema-driven.
- Use `--help` and `--help --json` as the public introspection surface.

## Why `events` are removed for now

The previous `events: []` field represented buffered in-process emissions that
were returned only after the handler finished. That shape looked like streaming,
but it was still a one-shot unary response.

That is misleading for both app authors and machine clients, so V1 should stay
honest: unary request in, unary response out.

## Transport split

We should treat transports as adapters around the same descriptor/runtime core:

- `stdio`: local CLI and future agent-oriented local transport
- `ConnectRPC` over HTTP: remote/client-server transport

These transports can expose the same command metadata and execution model while
choosing different framing details.

## Live events

If we add live events later, they should come back only on a persistent
transport:

- `stdio`: likely a future `cmdproto serve` mode with framed messages
- `ConnectRPC`: likely a streaming RPC or operation watch surface

Important rule: live events should not be smuggled back into unary
`CommandResponseJson` as buffered `events`.

## Introspection caching

If a future persistent client needs caching, it can key cached structured help
payloads by a hash of the current command schema. That is still only a cache
optimization, not a session concept.

Example flow for a persistent client:

1. Client requests structured help
2. Server returns method metadata plus a schema hash
3. Client caches the help payload under that hash
4. Later, the client reconnects and sees the same hash
5. Client reuses the cached metadata instead of downloading/parsing it again
6. If the schema changes, the server returns a different hash and the client refreshes

For a one-shot CLI invocation or a stateless AI assistant run, that hash may not
help much because the client can simply ask for help again.

So hash-based caching should be treated as an optional optimization for
persistent clients, not a required V1 mechanism. We can defer it until a
persistent transport actually needs it.
