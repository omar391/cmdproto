import { execFileSync } from "node:child_process";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScalarType, type DescField } from "@bufbuild/protobuf";
import {
  commandOutcome,
  getDefaultManifestPath,
  loadSchemaFromFile,
  parseHumanCommand,
  runCli,
  validateMethodSpecs,
  type FieldSpec,
  type MethodSpec,
  type ParamOptions
} from "../runtimes/runtime.js";
import {
  createGreeterRuntime,
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

before(() => {
  execFileSync("npm", ["run", "schema:build"], { stdio: "ignore" });
  execFileSync("npm", ["run", "schema:build:greeter"], { stdio: "ignore" });
});

function parseStdout(stdout: string) {
  return JSON.parse(stdout);
}

describe("cmdproto descriptors", () => {
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
