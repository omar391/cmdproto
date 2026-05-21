import { execFileSync } from "node:child_process";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScalarType, type DescField } from "@bufbuild/protobuf";
import {
  loadSchemaFromFile,
  parseHumanCommand,
  renderHelp,
  runCli,
  validateMethodSpecs,
  type FieldSpec,
  type MethodSpec,
  type ParamOptions
} from "../src/index.js";
import {
  createGreeterRuntime,
  GREETER_SCHEMA_PATH,
  GREETER_METHOD
} from "../examples/greeter/src/app.js";

const SCHEMA_PATH = GREETER_SCHEMA_PATH;

before(() => {
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
});

describe("cmdproto runtime", () => {
  it("executes equivalent human and machine commands through the same handler", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);

    const human = parseStdout((await runCli(runtime, ["greet", "Ada", "--shout"])).stdout);
    const machine = parseStdout(
      (
        await runCli(runtime, [
          "cmdproto",
          "invoke",
          "--json",
          JSON.stringify({
            method: GREETER_METHOD,
            params: { name: "Ada", shout: true },
            requestId: "req-1"
          })
        ])
      ).stdout
    );

    assert.equal(human.ok, true);
    assert.deepEqual(human.result, { message: "HELLO, ADA!" });
    assert.equal(machine.ok, true);
    assert.deepEqual(machine.result, human.result);
    assert.equal(machine.requestId, "req-1");
  });

  it("rejects undeclared methods", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const response = await runtime.dispatch({
      method: "greeter.v1.GreeterService.Nope",
      params: {},
      requestId: "missing-method"
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, "METHOD_NOT_FOUND");
    assert.equal(response.requestId, "missing-method");
  });

  it("fails closed for unknown human flags", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const result = await runCli(runtime, ["greet", "Ada", "--unknown"]);
    const response = parseStdout(result.stdout);

    assert.equal(result.statusCode, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_ARGUMENT");
  });

  it("fails closed for unknown machine fields", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const result = await runCli(runtime, [
      "cmdproto",
      "invoke",
      "--json",
      JSON.stringify({
        method: GREETER_METHOD,
        params: { name: "Ada", extra: "blocked" }
      })
    ]);
    const response = parseStdout(result.stdout);

    assert.equal(result.statusCode, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_ARGUMENT");
  });

  it("fails closed for unknown request envelope fields", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const response = await runtime.dispatch({
      method: GREETER_METHOD,
      params: { name: "Ada" },
      extra: "blocked"
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_REQUEST");
  });

  it("generates help and method listing from descriptors", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const help = renderHelp(runtime.schema);
    const listed = parseStdout(
      (await runCli(runtime, ["cmdproto", "methods", "list"])).stdout
    );
    const described = parseStdout(
      (await runCli(runtime, ["cmdproto", "methods", "describe", GREETER_METHOD])).stdout
    );

    assert.match(help, /greet <NAME> \[-s, --shout\]\s+Render a greeting\./);
    assert.match(help, /cmdproto invoke --json/);
    assert.equal(listed.ok, true);
    assert.equal(listed.result.methods[0].method, GREETER_METHOD);
    assert.equal(described.ok, true);
    assert.equal(described.result.fields[0].name, "name");
    assert.equal(described.result.fields[1].shortFlag, "s");
    assert.equal(described.result.examples[0].command, "greeter greet Ada -s");
  });

  it("exports the descriptor set through introspection", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const exported = parseStdout(
      (await runCli(runtime, ["cmdproto", "schema", "export"])).stdout
    );

    assert.equal(exported.ok, true);
    assert.equal(exported.result.format, "file_descriptor_set.binpb.base64");
    assert.ok(Buffer.from(exported.result.schema, "base64").byteLength > 0);
  });

  it("returns a stable machine-parseable error envelope", async () => {
    const runtime = createGreeterRuntime(SCHEMA_PATH);
    const response = parseStdout(
      (
        await runCli(runtime, [
          "cmdproto",
          "invoke",
          "--json",
          JSON.stringify({
            method: "greeter.v1.GreeterService.Missing",
            params: {},
            requestId: "err-1"
          })
        ])
      ).stdout
    );

    assert.deepEqual(Object.keys(response).sort(), ["error", "events", "ok", "requestId"]);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "METHOD_NOT_FOUND");
    assert.deepEqual(response.events, []);
    assert.equal(response.requestId, "err-1");
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
    const method = mockMethod("cmdproto invoke", [mockField("name", { positional: { index: 1 } })]);

    assert.throws(
      () => validateMethodSpecs([method]),
      /reserved command root "cmdproto"/
    );
  });
});

function mockMethod(path: string, fields: FieldSpec[]): MethodSpec {
  return {
    name: `test.v1.TestService.${path.replace(/\s+/g, "_")}`,
    serviceName: "test.v1.TestService",
    rpcName: "Call",
    input: {} as MethodSpec["input"],
    output: {} as MethodSpec["output"],
    descriptor: { deprecated: false } as MethodSpec["descriptor"],
    command: {
      path,
      summary: "test",
      alias: [],
      example: [],
      hidden: false,
      deprecated: false
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
