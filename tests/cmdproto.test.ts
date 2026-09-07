import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fromBinary,
  ScalarType,
  toBinary,
  type DescField
} from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import {
  CmdProtoError,
  commandOutcome,
  createRuntimeFromFile,
  executeApp,
  getDefaultManifestPath,
  loadSchemaFromFile,
  parseHumanCommand,
  runCli,
  validateMethodSpecs,
  type FieldSpec,
  type HandlerMap,
  type MethodSpec,
  type ParamOptions
} from "../runtimes/runtime.js";
import { CMDPROTO_INTERNAL_CONNECT_ARG } from "../runtimes/runtime.js";
import {
  createCmdProtoInternalServer,
  ensureCmdProtoServer
} from "../connect/bootstrap.js";
import { createCmdProtoConnectTransport } from "../connect/core.js";
import {
  createCmdProtoBunHandler,
  createCmdProtoBunNodeHandler
} from "../connect/bun.js";
import { createCmdProtoFetchHandler } from "../connect/fetch.js";
import { createCmdProtoNodeHandler } from "../connect/node.js";
import {
  createGreeterRuntime,
  GREETER_MANIFEST_PATH,
  GREETER_SCHEMA_PATH,
  GREETER_METHOD,
  GREETER_CARD_METHOD
} from "../examples/greeter/src/app.js";

const SCHEMA_PATH = GREETER_SCHEMA_PATH;
const GREETER_REQUEST_JSON = "{\"name\":\"Ada\",\"shout\":true}";
const GREETER_EXECJSON_CMD =
  `greeter cmdproto execjson greet '${GREETER_REQUEST_JSON}'`;
const GREETER_CARD_REQUEST_JSON =
  "{\"prefix\":\"welcome\",\"payload\":{\"name\":\"Ada\",\"shout\":true}}";
const HOST_LOCAL_BUILD_PATH =
  /(?:\/(?:Users|home|Volumes|workspace|workspaces|builds|tmp|private|opt|usr|var)\/|[A-Za-z]:[\\/](?:Users|workspace|workspaces|builds)[\\/]|worktrees[\\/])/;

before(() => {
  execFileSync("npm", ["run", "schema:build"], { stdio: "ignore" });
  execFileSync("npm", ["run", "schema:build:greeter"], { stdio: "ignore" });
});

describe("packaged WASM artifacts", () => {
  for (const artifact of [
    "cmdproto-buf-plugin.wasm",
    "cmdproto-runtime-manifest.wasm"
  ]) {
    it(`${artifact} does not embed host-local build paths`, () => {
      const binaryText = readFileSync(
        join(process.cwd(), "dist", "wasm", artifact)
      ).toString("latin1");

      assert.doesNotMatch(binaryText, HOST_LOCAL_BUILD_PATH);
    });
  }
});

function parseStdout(stdout: string) {
  return JSON.parse(stdout);
}

describe("cmdproto descriptors", () => {
  it("prints root and subcommand help through the unified cli", () => {
    const root = execFileSync(process.execPath, ["scripts/cmdproto.mjs", "--help"], {
      encoding: "utf8"
    });
    const init = execFileSync(process.execPath, ["scripts/cmdproto.mjs", "init", "--help"], {
      encoding: "utf8"
    });
    const build = execFileSync(process.execPath, ["scripts/cmdproto.mjs", "build", "--help"], {
      encoding: "utf8"
    });

    assert.match(root, /Usage: cmdproto <command> \[options\]/);
    assert.match(root, /build\s+Generate, lint, and compile cmdproto runtime artifacts/);
    assert.match(init, /Usage: cmdproto init \[options\]/);
    assert.match(build, /Usage: cmdproto build \[options\]/);
  });

  it("rejects unknown subcommands through the unified cli", () => {
    const result = spawnSync(process.execPath, ["scripts/cmdproto.mjs", "nope"], {
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command: nope/);
  });

  it("bootstraps consumer scripts through the package build helper", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cmdproto-bootstrap-"));

    execFileSync(process.execPath, [
      "scripts/cmdproto.mjs",
      "init",
      "--cwd",
      cwd,
      "--app-name",
      "demo"
    ]);

    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));

    assert.equal(pkg.scripts["cmdproto:gen"], "cmdproto build --generate-only --buf-config buf.yaml");
    assert.equal(pkg.scripts["cmdproto:schema"], "cmdproto build --app-name demo --buf-config buf.yaml");
    assert.doesNotMatch(pkg.scripts["cmdproto:schema"], /buf lint|mkdir -p|runtime-manifest/);
  });

  it("bootstraps the opt-in Connect handler without owning a listener", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cmdproto-connect-bootstrap-"));

    execFileSync(process.execPath, [
      "scripts/cmdproto.mjs",
      "init",
      "--cwd",
      cwd,
      "--app-name",
      "demo",
      "--runtime",
      "ts",
      "--connect"
    ]);

    const source = readFileSync(join(cwd, "src/cmdproto/connect.mts"), "utf8");

    assert.match(source, /createCmdProtoFetchHandler/);
    assert.match(source, /createCmdProtoInternalServer/);
    assert.match(source, /createInternalConnectServer/);
    assert.match(source, /allowMethods:\s*\[METHOD_NAME\]/);
    assert.match(source, /authorize/);
    assert.doesNotMatch(source, /\.listen\(|Bun\.serve|createServer/);
  });

  it("keeps a consumer CLI-first while reserving a package-owned server mode", async () => {
    const runtime = createGreeterRuntime();
    let serverRuns = 0;
    const internalServer = createCmdProtoInternalServer({
      allowMethods: [GREETER_METHOD],
      authorize: () => true,
      mount: () => {
        serverRuns += 1;
        return { closed: Promise.resolve() };
      }
    });

    const result = await executeApp({
      handlers: runtime.handlers,
      schemaPath: GREETER_SCHEMA_PATH,
      manifestPath: GREETER_MANIFEST_PATH,
      argv: [CMDPROTO_INTERNAL_CONNECT_ARG],
      internalServer
    });

    assert.deepEqual(result, { statusCode: 0, stdout: "", stderr: "" });
    assert.equal(serverRuns, 1);

    const cli = await executeApp({
      handlers: runtime.handlers,
      schemaPath: GREETER_SCHEMA_PATH,
      manifestPath: GREETER_MANIFEST_PATH,
      argv: ["greet", "Ada"]
    });
    assert.deepEqual(JSON.parse(cli.stdout), { message: "Hello, Ada!" });
  });

  it("ensures a missing capability by spawning the same executable in internal mode", async () => {
    type Capability = { readonly baseUrl: string };
    let capability: Capability | undefined;
    let spawned: { executable: string; args: readonly string[] } | undefined;
    const child = new EventEmitter();
    Object.assign(child, { unref: () => child });
    const value = await ensureCmdProtoServer<Capability>({
      lockKey: `test-${process.pid}-${Date.now()}`,
      readCapability: () => capability,
      executable: process.execPath,
      args: ["consumer-entry.mjs"],
      pollMs: 1,
      timeoutMs: 1_000,
      spawn: ((executable: string, args: readonly string[]) => {
        spawned = { executable, args };
        queueMicrotask(() => { capability = { baseUrl: "http://127.0.0.1:4312" }; });
        return child;
      }) as unknown as typeof import("node:child_process").spawn
    });

    assert.deepEqual(value, { baseUrl: "http://127.0.0.1:4312" });
    assert.equal(spawned?.executable, process.execPath);
    assert.deepEqual(spawned?.args, ["consumer-entry.mjs", CMDPROTO_INTERNAL_CONNECT_ARG]);
  });

  it("discovers command paths and param bindings from the descriptor set", () => {
    const schema = loadSchemaFromFile(SCHEMA_PATH);
    const method = schema.methodByName.get(GREETER_METHOD);

    assert.ok(method);
    assert.equal(method.command.path, "greet");
    assert.equal(method.command.summary, "Render a greeting.");
    assert.deepEqual(method.command.alias, ["hello"]);
    assert.equal(method.command.example[0]?.command, "greet Ada -s");
    assert.equal(
      method.command.example[0]?.requestJson,
      GREETER_REQUEST_JSON
    );
    assert.equal(method.fields.find((field) => field.name === "name")?.param.positional?.index, 1);
    assert.equal(method.fields.find((field) => field.name === "shout")?.param.flag?.long, "shout");
    assert.equal(method.fields.find((field) => field.name === "shout")?.param.flag?.short, "s");
  });

  it("maps human CLI arguments to the same method request shape as machine JSON", () => {
    const schema = loadSchemaFromFile(SCHEMA_PATH);
    const request = parseHumanCommand(schema, ["greet", "Ada", "-s"]);

    assert.deepEqual(request, {
      method: GREETER_METHOD,
      params: {
        name: "Ada",
        shout: true
      }
    });
  });

  it("rejects direct command --json payloads when no field-level JSON binding exists", () => {
    const schema = loadSchemaFromFile(SCHEMA_PATH);

    assert.throws(
      () => parseHumanCommand(schema, ["greet", "--json", GREETER_REQUEST_JSON]),
      /Unknown flag: --json/
    );
  });

  it("maps field-level --json payloads alongside scalar flags", () => {
    const schema = loadSchemaFromFile(SCHEMA_PATH);
    const request = parseHumanCommand(schema, [
      "card",
      "--prefix",
      "welcome",
      "--json",
      "{\"name\":\"Ada\",\"shout\":true}"
    ]);

    assert.deepEqual(request, {
      method: GREETER_CARD_METHOD,
      params: {
        prefix: "welcome",
        payload: {
          name: "Ada",
          shout: true
        }
      }
    });
  });
});

describe("cmdproto runtime", () => {
  it("executes equivalent human and machine commands through the same handler", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);

    const human = parseStdout((await runCli(runtime, ["greet", "Ada", "--shout"])).stdout);
    const machine = parseStdout(
      (
        await runCli(runtime, [
          "cmdproto",
          "execjson",
          "greet",
          GREETER_REQUEST_JSON
        ])
      ).stdout
    );

    assert.deepEqual(human, { message: "HELLO, ADA!" });
    assert.deepEqual(machine, human);
  });

  it("executes machine JSON from stdin when @- is used", () => {
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "examples/greeter/src/app.ts",
        "cmdproto",
        "execjson",
        "greet",
        "@-"
      ],
      {
        cwd: process.cwd(),
        input: GREETER_REQUEST_JSON,
        encoding: "utf8"
      }
    );
    const response = parseStdout(stdout);

    assert.deepEqual(response, { message: "HELLO, ADA!" });
  });

  it("executes field-level JSON from stdin when --json @- is used", () => {
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "examples/greeter/src/app.ts",
        "card",
        "--prefix",
        "welcome",
        "--json",
        "@-"
      ],
      {
        cwd: process.cwd(),
        input: "{\"name\":\"Ada\",\"shout\":true}",
        encoding: "utf8"
      }
    );
    const response = parseStdout(stdout);

    assert.deepEqual(response, { message: "WELCOME: HELLO, ADA!" });
  });

  it("rejects undeclared methods", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);

    await assert.rejects(
      () =>
        runtime.dispatch({
          method: "greeter.v1.GreeterService.Nope",
          params: {},
          requestId: "missing-method"
        }),
      /Unknown method: greeter\.v1\.GreeterService\.Nope/
    );
  });

  it("fails closed for unknown human flags", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const result = await runCli(runtime, ["greet", "Ada", "--unknown"]);

    assert.equal(result.statusCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown flag: --unknown/);
  });

  it("fails closed for unknown machine fields", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const result = await runCli(runtime, [
      "cmdproto",
      "execjson",
      "greet",
      JSON.stringify({
        name: "Ada",
        extra: "blocked"
      })
    ]);
    const response = parseStdout(result.stdout);

    assert.equal(result.statusCode, 1);
    assert.equal(response.error.code, "INVALID_ARGUMENT");
  });

  it("rejects bare execjson without an explicit JSON source", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const response = parseStdout(
      (
        await runCli(runtime, [
          "cmdproto",
          "execjson",
          "greet"
        ])
      ).stdout
    );

    assert.equal(response.error.code, "INVALID_ARGUMENT");
    assert.match(response.error.message, /Usage: cmdproto execjson <path> <json\|@file\|@->/);
  });

  it("fails fast when the runtime manifest is missing", () => {
    assert.throws(
      () => createGreeterRuntime(SCHEMA_PATH, "/tmp/cmdproto-missing-runtime.binpb"),
      /ENOENT/
    );
  });

  it("fails fast when the runtime manifest hash does not match the descriptor set", () => {
    assert.throws(
      () => createGreeterRuntime(SCHEMA_PATH, getDefaultManifestPath()),
      /descriptor hash mismatch/
    );
  });

  it("fails closed for unknown request envelope fields", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    await assert.rejects(
      () =>
        runtime.dispatch({
          method: GREETER_METHOD,
          params: { name: "Ada" },
          extra: "blocked"
        }),
      /Unknown request field: extra/
    );
  });

  it("renders coherent text and JSON help from the manifest", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const help = (await runCli(runtime, ["--help"])).stdout;
    const globalJson = parseStdout(
      (await runCli(runtime, ["--help", "--json"])).stdout
    );
    const commandHelp = await runCli(runtime, ["greet", "--help"]);
    const commandJsonStdout = (await runCli(runtime, ["greet", "--help", "--json"])).stdout;
    const commandJson = parseStdout(commandJsonStdout);
    const controlJson = parseStdout(
      (await runCli(runtime, ["cmdproto", "--help", "--json"])).stdout
    );
    const greetSummary = globalJson.commands.find((command: { path: string }) => command.path === "greet");

    assert.match(help, /greet <NAME> \[-s, --shout\]\s+Render a greeting\./);
    assert.doesNotMatch(help, /--json --verbose/);
    assert.match(help, /cmdproto execjson <path> <json\|@file\|@->/);
    assert.equal(greetSummary?.path, "greet");
    assert.equal(globalJson.execjson.usage, "cmdproto execjson <path> <json|@file|@->");
    assert.match(commandHelp.stdout, /Usage:\n  greet <NAME> \[-s, --shout\]/);
    assert.match(commandHelp.stdout, /Machine method:\n  greeter\.v1\.GreeterService\.SayHello/);
    assert.match(commandHelp.stdout, /Machine execjson:\n  cmdproto execjson greet <json\|@file\|@->/);
    assert.match(commandHelp.stdout, /Payload type:\n  greeter\.v1\.SayHelloRequest/);
    assert.match(commandHelp.stdout, /Result type:\n  greeter\.v1\.SayHelloResponse/);
    assert.match(commandHelp.stdout, /Parameters:\n  CLI param\s+JSON param\s+Position\s+Type\s+Description/);
    assert.match(commandHelp.stdout, /<NAME>\s+name\s+1\s+string\s+Name to greet\./);
    assert.match(commandHelp.stdout, /-s, --shout\s+shout\s+-\s+boolean\s+Uppercase the greeting\./);
    assert.match(commandHelp.stdout, /Examples:\n  Description\s+Normal cmd\s+JSON cmd/);
    assert.match(commandHelp.stdout, /Render a loud greeting\.\s+greeter greet Ada -s\s+greeter cmdproto execjson greet '\{"name":"Ada","shout":true\}'/);
    assert.equal(commandJson.method, GREETER_METHOD);
    assert.equal(commandJson.path, "greet");
    assert.equal(commandJson.input_type, "greeter.v1.SayHelloRequest");
    assert.equal(commandJson.output_type, "greeter.v1.SayHelloResponse");
    assert.equal(commandJson.machine_usage, "cmdproto execjson greet <json|@file|@->");
    assert.equal(commandJson.payload_json_schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(commandJson.payload_json_schema.type, "object");
    assert.equal(commandJson.payload_json_schema.properties.name.type, "string");
    assert.equal(commandJson.payload_json_schema.properties.shout.type, "boolean");
    assert.equal(commandJson.payload_schema.name.type, "string");
    assert.equal(commandJson.payload_schema.shout.type, "boolean");
    assert.equal(commandJson.payload_schema.name.help, "Name to greet.");
    assert.equal(commandJson.payload_schema.shout.help, "Uppercase the greeting.");
    assert.ok(!("positionalIndex" in commandJson.payload_schema.name));
    assert.ok(!("longFlag" in commandJson.payload_schema.shout));
    assert.ok(!("shortFlag" in commandJson.payload_schema.shout));
    assert.equal(commandJson.examples[0].description, "Render a loud greeting.");
    assert.equal(commandJson.examples[0].cmd, GREETER_EXECJSON_CMD);
    assert.ok(
      commandJsonStdout.indexOf('"payload_json_schema"') <
        commandJsonStdout.indexOf('"payload_schema"'),
      "help JSON should render payload_json_schema before payload_schema"
    );
    assert.ok(
      commandJsonStdout.indexOf('"payload_schema"') <
        commandJsonStdout.indexOf('"examples"'),
      "help JSON should render payload_schema before examples"
    );
    assert.equal(controlJson.execjson.name, "cmdproto execjson");
  });

  it("treats the removed verbose help flag like an unknown extra token", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const response = await runCli(runtime, ["greet", "--help", "--json", "--verbose"]);

    assert.equal(response.statusCode, 1);
    assert.equal(response.stdout, "");
    assert.match(response.stderr, /Unknown command: greet --verbose/);
  });

  it("ignores a leading script-runner separator before top-level commands", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const helpJson = parseStdout(
      (await runCli(runtime, ["--", "greet", "--help", "--json"])).stdout
    );
    const command = parseStdout(
      (await runCli(runtime, ["--", "greet", "Ada", "-s"])).stdout
    );

    assert.equal(helpJson.payload_schema.name.type, "string");
    assert.deepEqual(command, { message: "HELLO, ADA!" });
  });

  it("returns a stable machine-parseable error envelope", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const response = parseStdout(
      (
        await runCli(runtime, [
          "cmdproto",
          "execjson",
          "missing",
          "{}"
        ])
      ).stdout
    );

    assert.deepEqual(Object.keys(response), ["error"]);
    assert.equal(response.error.code, "METHOD_NOT_FOUND");
    assert.match(response.error.message, /Unknown command: missing/);
  });
});

describe("cmdproto Connect", () => {
  it("is default-deny and routes only canonical descriptor-derived paths", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    let authorizationCalls = 0;
    const deniedHandler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [],
      authorize() {
        authorizationCalls += 1;
        return true;
      }
    });

    const denied = await deniedHandler(
      new Request(`http://cmdproto.test/${GREETER_METHOD}`, {
        method: "POST",
        headers: connectHeaders(),
        body: new Uint8Array()
      })
    );

    assert.equal(denied.status, 404);
    assert.equal(authorizationCalls, 0);

    const allowedHandler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true
    });
    const restAlias = await allowedHandler(
      new Request("http://cmdproto.test/afn/v1/session-tickets", {
        method: "POST",
        headers: connectHeaders(),
        body: new Uint8Array()
      })
    );
    const dottedPath = await allowedHandler(
      new Request(`http://cmdproto.test/${GREETER_METHOD}`, {
        method: "POST",
        headers: connectHeaders(),
        body: new Uint8Array()
      })
    );
    const streaming = await allowedHandler(
      new Request("http://cmdproto.test/greeter.v1.GreeterService/SayHello", {
        method: "POST",
        headers: {
          "connect-protocol-version": "1",
          "content-type": "application/connect+proto"
        },
        body: new Uint8Array()
      })
    );

    assert.equal(restAlias.status, 404);
    assert.equal(dottedPath.status, 404);
    assert.equal(streaming.status, 415);
  });

  it("serves a bare declared Protobuf response through the shared handler", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const handler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true
    });
    const prepared = runtime.prepareProtobufRequest({
      method: GREETER_METHOD,
      params: { name: "Ada", shout: true }
    });

    const response = await handler(
      new Request("http://cmdproto.test/greeter.v1.GreeterService/SayHello", {
        method: "POST",
        headers: connectHeaders(),
        body: toBinary(prepared.method.input, prepared.message)
      })
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const message = fromBinary(prepared.method.output, bytes);
    const outcome = runtime.decodeProtobufResponse(GREETER_METHOD, message);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/proto");
    assert.deepEqual(outcome.result, { message: "HELLO, ADA!" });
    assert.equal(outcome.statusCode, 0);
  });

  it("supports strict diagnostic Connect JSON without a transport envelope", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const handler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true
    });
    const response = await handler(
      connectJsonRequest(GREETER_METHOD, { name: "Ada", shout: true })
    );
    const body = await response.json() as Record<string, unknown>;
    const malformed = await handler(
      connectJsonRequest(GREETER_METHOD, { name: "Ada", unknown: "blocked" })
    );
    const malformedBody = await malformed.json() as { code: string };

    assert.equal(response.status, 200);
    assert.deepEqual(body, { message: "HELLO, ADA!" });
    assert.ok(!("ok" in body));
    assert.ok(!("result" in body));
    assert.ok(!("stdout" in body));
    assert.equal(malformed.status, 400);
    assert.equal(malformedBody.code, "invalid_argument");
  });

  it("passes explicit auth context and official interceptors to the one handler", async () => {
    let handlerContext: unknown;
    let interceptedMethod = "";
    const handlers: HandlerMap = {
      [GREETER_METHOD](params, context) {
        handlerContext = context.requestContext;
        return { message: String(params.name ?? "") };
      }
    };
    const runtime = createRuntimeFromFile(handlers, SCHEMA_PATH, GREETER_MANIFEST_PATH);
    const interceptor: Interceptor = (next) => async (request) => {
      interceptedMethod = request.method.name;
      return next(request);
    };
    const handler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      createRequestContext(info) {
        return { principal: info.requestHeader.get("authorization") };
      },
      authorize(info) {
        return info.requestContext.principal === "Bearer allowed";
      },
      interceptors: [interceptor]
    });

    const response = await handler(
      connectJsonRequest(
        GREETER_METHOD,
        { name: "Ada" },
        { authorization: "Bearer allowed" }
      )
    );
    const forbidden = await handler(
      connectJsonRequest(GREETER_METHOD, { name: "Ada" })
    );
    const forbiddenBody = await forbidden.json() as { code: string };

    assert.equal(response.status, 200);
    assert.deepEqual(handlerContext, { principal: "Bearer allowed" });
    assert.equal(interceptedMethod, "SayHello");
    assert.equal(forbidden.status, 403);
    assert.equal(forbiddenBody.code, "permission_denied");
  });

  it("maps typed failures to canonical Connect errors and hides untyped internals", async () => {
    const handlers: HandlerMap = {
      [GREETER_METHOD](params) {
        if (params.name === "denied") {
          throw new CmdProtoError("PERMISSION_DENIED", "request denied");
        }
        if (params.name === "custom") {
          throw new CmdProtoError(
            "PRIVATE_SCHEDULER_STATE",
            "sensitive custom failure",
            { internalState: "draining" }
          );
        }
        throw new Error("sensitive implementation detail");
      }
    };
    const runtime = createRuntimeFromFile(handlers, SCHEMA_PATH, GREETER_MANIFEST_PATH);
    const handler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true
    });
    const denied = await handler(
      connectJsonRequest(GREETER_METHOD, { name: "denied" })
    );
    const deniedBody = await denied.json() as { code: string; message: string };
    const crashed = await handler(
      connectJsonRequest(GREETER_METHOD, { name: "crash" })
    );
    const crashedBody = await crashed.json() as { code: string; message: string };
    const custom = await handler(
      connectJsonRequest(GREETER_METHOD, { name: "custom" })
    );
    const customBody = await custom.json() as {
      code: string;
      message: string;
      details?: unknown;
    };

    assert.equal(denied.status, 403);
    assert.deepEqual(deniedBody, {
      code: "permission_denied",
      message: "request denied"
    });
    assert.equal(crashed.status, 500);
    assert.equal(crashedBody.code, "internal");
    assert.doesNotMatch(crashedBody.message, /sensitive/);
    assert.equal(custom.status, 500);
    assert.deepEqual(customBody, { code: "unknown", message: "internal error" });
  });

  it("rejects malformed and oversized request bodies before handler invocation", async () => {
    let calls = 0;
    const handlers: HandlerMap = {
      [GREETER_METHOD]() {
        calls += 1;
        return { message: "unexpected" };
      }
    };
    const runtime = createRuntimeFromFile(handlers, SCHEMA_PATH, GREETER_MANIFEST_PATH);
    const malformedHandler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true,
      readMaxBytes: 1024
    });
    const oversizedHandler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true,
      readMaxBytes: 4
    });
    const malformed = await malformedHandler(
      connectProtoRequest(new Uint8Array([0x0a, 0x05, 0x41]))
    );
    const oversized = await oversizedHandler(
      connectProtoRequest(new Uint8Array([0x0a, 0x05, 0x41, 0x41, 0x41, 0x41, 0x41]))
    );
    const malformedBody = await malformed.json() as { code: string };
    const oversizedBody = await oversized.json() as { code: string };

    assert.equal(malformed.status, 400);
    assert.equal(malformedBody.code, "invalid_argument");
    assert.equal(oversized.status, 429);
    assert.equal(oversizedBody.code, "resource_exhausted");
    assert.equal(calls, 0);
  });

  it("keeps human and execjson presentation identical across local and remote dispatch", async () => {
    let handlerCalls = 0;
    let fetchCalls = 0;
    const handlers: HandlerMap = {
      [GREETER_METHOD](params) {
        handlerCalls += 1;
        const message = `Hello, ${String(params.name ?? "")}!`;
        return { message: params.shout ? message.toUpperCase() : message };
      },
      [GREETER_CARD_METHOD]() {
        return { message: "local card" };
      }
    };
    const runtime = createRuntimeFromFile(handlers, SCHEMA_PATH, GREETER_MANIFEST_PATH);
    const serverHandler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize(info) {
        return info.requestHeader.get("authorization") === "Bearer allowed";
      }
    });
    const transport = createCmdProtoConnectTransport({
      remoteMethods: [GREETER_METHOD],
      baseUrl: () => "http://cmdproto.test",
      headers: () => ({ authorization: "Bearer allowed" }),
      async fetch(request) {
        fetchCalls += 1;
        return serverHandler(request);
      }
    });

    const local = parseStdout((await runCli(runtime, ["greet", "Ada", "-s"])).stdout);
    const remoteHuman = parseStdout(
      (await runCli(runtime, ["greet", "Ada", "-s"], "", transport)).stdout
    );
    const remoteMachine = parseStdout(
      (
        await runCli(
          runtime,
          ["cmdproto", "execjson", "greet", GREETER_REQUEST_JSON],
          "",
          transport
        )
      ).stdout
    );
    const stillLocal = parseStdout(
      (
        await runCli(
          runtime,
          ["card", "--prefix", "ignored", "--json", "{}"],
          "",
          transport
        )
      ).stdout
    );

    assert.deepEqual(remoteHuman, local);
    assert.deepEqual(remoteMachine, local);
    assert.deepEqual(stillLocal, { message: "local card" });
    assert.equal(fetchCalls, 2);
    assert.equal(handlerCalls, 3);
  });

  it("round-trips canonical remote failures into existing CLI error rendering", async () => {
    const handlers: HandlerMap = {
      [GREETER_METHOD]() {
        throw new CmdProtoError(
          "FAILED_PRECONDITION",
          "scheduler is not ready",
          { state: "starting", retryAfterMs: 250 }
        );
      }
    };
    const runtime = createRuntimeFromFile(handlers, SCHEMA_PATH, GREETER_MANIFEST_PATH);
    const serverHandler = createCmdProtoFetchHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true
    });
    const transport = createCmdProtoConnectTransport({
      remoteMethods: [GREETER_METHOD],
      baseUrl: "http://cmdproto.test",
      fetch: serverHandler
    });
    const human = await runCli(runtime, ["greet", "Ada"], "", transport);
    const machine = await runCli(
      runtime,
      ["cmdproto", "execjson", "greet", "{\"name\":\"Ada\"}"],
      "",
      transport
    );
    const machineBody = parseStdout(machine.stdout);

    assert.equal(human.statusCode, 1);
    assert.match(human.stderr, /scheduler is not ready/);
    assert.equal(machine.statusCode, 1);
    assert.equal(machineBody.error.code, "FAILED_PRECONDITION");
    assert.deepEqual(machineBody.error.details, {
      state: "starting",
      retryAfterMs: 250
    });
  });

  it("runs the same finite handler behind the Fetch, Bun, and Node host adapters", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const options = {
      runtime,
      allowMethods: [GREETER_METHOD],
      authorize: () => true
    };
    const fetchHandler = createCmdProtoFetchHandler(options);
    const bunHandler = createCmdProtoBunHandler(options);
    const fetchResponse = await fetchHandler(
      connectJsonRequest(GREETER_METHOD, { name: "Fetch" })
    );
    const bunResponse = await bunHandler(
      connectJsonRequest(GREETER_METHOD, { name: "Bun" })
    );
    const server = createServer(createCmdProtoNodeHandler(options));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const nodeResponse = await fetch(
        `http://127.0.0.1:${address.port}/greeter.v1.GreeterService/SayHello`,
        {
          method: "POST",
          headers: {
            ...connectHeaders(),
            "content-type": "application/json"
          },
          body: JSON.stringify({ name: "Node" })
        }
      );

      assert.deepEqual(await fetchResponse.json(), { message: "Hello, Fetch!" });
      assert.deepEqual(await bunResponse.json(), { message: "Hello, Bun!" });
      assert.deepEqual(await nodeResponse.json(), { message: "Hello, Node!" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rejects duplicate security singleton headers before authorization", async () => {
    let authorizationCalls = 0;
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const server = createServer(createCmdProtoBunNodeHandler({
      runtime,
      allowMethods: [GREETER_METHOD],
      singletonHeaders: ["x-capability"],
      authorize() {
        authorizationCalls += 1;
        return true;
      }
    }));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      for (const [name, values] of [
        ["authorization", ["Bearer first", "Bearer second"]],
        ["host", ["first.example", "second.example"]],
        ["origin", ["https://first.example", "https://second.example"]],
        ["x-capability", ["first", "second"]]
      ] as const) {
        const response = await nodeHttpRequest(
          address.port,
          {
            "connect-protocol-version": "1",
            "content-type": "application/json",
            [name]: [...values]
          },
          JSON.stringify({ name: "Ada" })
        );

        assert.equal(response.statusCode, 400);
        assert.deepEqual(JSON.parse(response.body), {
          code: "invalid_argument",
          message: `duplicate header is not allowed: ${name}`
        });
      }
      assert.equal(authorizationCalls, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("imports every opt-in surface without binding a listener", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await Promise.all([import('cmdproto/connect'),import('cmdproto/connect/fetch'),import('cmdproto/connect/bun'),import('cmdproto/connect/node')])"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 2_000
      }
    );

    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  });
});

function nodeHttpRequest(
  port: number,
  headers: Record<string, string | string[]>,
  body: string
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("connect", () => {
      const headerLines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`)
      );
      socket.write([
        "POST /greeter.v1.GreeterService/SayHello HTTP/1.1",
        `host: 127.0.0.1:${port}`,
        `content-length: ${Buffer.byteLength(body)}`,
        "connection: close",
        ...headerLines,
        "",
        body
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const separator = raw.indexOf("\r\n\r\n");
      const status = /^HTTP\/1\.1 (\d{3})/m.exec(raw)?.[1];
      resolve({
        statusCode: status === undefined ? undefined : Number(status),
        body: separator === -1 ? "" : raw.slice(separator + 4)
      });
    });
  });
}

describe("cmdproto schema validation", () => {
  it("rejects duplicate short flags within a method", () => {
    const method = mockMethod("session create", [
      mockField("profile_name", { flag: { long: "profile", short: "p" } }),
      mockField("project_name", { flag: { long: "project", short: "p" } })
    ]);

    assert.throws(
      () => validateMethodSpecs([method]),
      /reuses short flag "p"/
    );
  });

  it("rejects reserved cmdproto command roots", () => {
    const method = mockMethod(
      "cmdproto execjson",
      [mockField("name", { positional: { index: 1 } })],
      {
        example: [
          {
            command: "session create demo",
            description: "test",
            requestJson: "{\"name\":\"demo\"}"
          }
        ]
      }
    );

    assert.throws(
      () => validateMethodSpecs([method]),
      /reserved command root "cmdproto"/
    );
  });

  it("rejects example commands that use cmdproto control syntax", () => {
    const method = mockMethod("session create", [mockField("name", { positional: { index: 1 } })], {
      example: [
        {
          command: "cmdproto execjson session create '{}'",
          description: "test",
          requestJson: "{}"
        }
      ]
    });

    assert.throws(
      () => validateMethodSpecs([method]),
      /must be human command syntax, not cmdproto control syntax/
    );
  });

  it("rejects reserved json long flags", () => {
    const method = mockMethod("session create", [
      mockField("output", { flag: { long: "json", short: "o" } })
    ]);

    assert.throws(
      () => validateMethodSpecs([method]),
      /reserved long flag "--json"/
    );
  });

  it("rejects missing command examples", () => {
    const method = mockMethod("session create", [mockField("name", { positional: { index: 1 } })], {
      example: []
    });

    assert.throws(
      () => validateMethodSpecs([method]),
      /must declare at least one cmdproto example/
    );
  });

  it("rejects missing request_json in command examples", () => {
    const method = mockMethod("session create", [mockField("name", { positional: { index: 1 } })], {
      example: [
        {
          command: "session create demo",
          description: "test",
          requestJson: ""
        }
      ]
    });

    assert.throws(
      () => validateMethodSpecs([method]),
      /missing request_json/
    );
  });

  it("allows verbose long flags now that cmdproto no longer uses them", () => {
    const method = mockMethod("session create", [
      mockField("output", { flag: { long: "verbose", short: "v" } })
    ]);

    assert.doesNotThrow(() => validateMethodSpecs([method]));
  });
});

function connectHeaders(extra: HeadersInit = {}): Record<string, string> {
  return Object.fromEntries(new Headers({
    "connect-protocol-version": "1",
    "content-type": "application/proto",
    ...Object.fromEntries(new Headers(extra))
  }));
}

function connectJsonRequest(
  methodName: string,
  body: unknown,
  headers: HeadersInit = {}
): Request {
  return new Request(`http://cmdproto.test${connectPath(methodName)}`, {
    method: "POST",
    headers: {
      ...connectHeaders(headers),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function connectProtoRequest(body: Uint8Array): Request {
  return new Request(
    "http://cmdproto.test/greeter.v1.GreeterService/SayHello",
    {
      method: "POST",
      headers: connectHeaders(),
      body: Uint8Array.from(body).buffer
    }
  );
}

function connectPath(methodName: string): string {
  const separator = methodName.lastIndexOf(".");
  assert.notEqual(separator, -1);
  return `/${methodName.slice(0, separator)}/${methodName.slice(separator + 1)}`;
}

function mockMethod(
  path: string,
  fields: FieldSpec[],
  command: Partial<MethodSpec["command"]> = {}
): MethodSpec {
  return {
    name: "test.v1.TestService.Call",
    serviceName: "test.v1.TestService",
    rpcName: "Call",
    input: {} as MethodSpec["input"],
    output: {} as MethodSpec["output"],
    descriptor: { deprecated: false } as MethodSpec["descriptor"],
    command: {
      path,
      summary: "test",
      alias: [],
      example: [
        {
          command: path,
          description: "test",
          requestJson: "{}"
        }
      ],
      hidden: false,
      deprecated: false,
      ...command
    },
    fields
  };
}

function mockField(name: string, param: Partial<ParamOptions> = {}): FieldSpec {
  return {
    name,
    jsonName: toJsonName(name),
    localName: toJsonName(name),
    descriptor: {
      name,
      fieldKind: "scalar",
      scalar: ScalarType.STRING
    } as unknown as DescField,
    param: {
      ...param,
      help: param.help ?? "",
      hidden: param.hidden ?? false
    }
  };
}

function toJsonName(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
