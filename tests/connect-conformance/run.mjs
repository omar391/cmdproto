import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONNECT_CONFORMANCE_REF = "5b2b709b99e2c8d4aa872fe51bb6a75f09d370e4";
const CONNECT_ES_REF = "b3ca30b1c6c0b6b7af7d505ef606ac1850cf2c2b";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const work = join(root, "tmp", "official-connect-conformance");
const conformance = join(work, "conformance");
const connectEs = join(work, "connect-es");
const runner = join(work, "connectconformance");
const config = join(root, "tests", "connect-conformance", "config.yaml");
const server = join(root, "tests", "connect-conformance", "server.mts");

mkdirSync(work, { recursive: true });
checkout(
  conformance,
  "https://github.com/connectrpc/conformance.git",
  CONNECT_CONFORMANCE_REF
);
checkout(
  connectEs,
  "https://github.com/connectrpc/connect-es.git",
  CONNECT_ES_REF
);
run("go", ["build", "-o", runner, "./cmd/connectconformance"], {
  cwd: conformance
});

const environment = {
  ...process.env,
  CMDPROTO_CONNECT_ES_ROOT: connectEs
};
const cases = [
  {
    name: "node",
    command: process.execPath,
    args: ["--import", "tsx", server, "node"],
    expected: { status: 0, passed: 88, failed: 0 }
  },
  {
    name: "fetch",
    command: process.execPath,
    args: ["--import", "tsx", server, "fetch"],
    expected: { status: 0, passed: 88, failed: 0 }
  },
  {
    name: "bun-node",
    command: "bun",
    args: [server, "bun-node"],
    expected: { status: 0, passed: 88, failed: 0 }
  },
  {
    name: "bun-fetch-normalization",
    command: "bun",
    args: [server, "bun-fetch"],
    expected: { status: 1, passed: 81, failed: 7 },
    expectedFailures: [
      "Basic/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/Codec:CODEC_JSON/Compression:COMPRESSION_IDENTITY/TLS:false/unary/success",
      "Basic/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/Codec:CODEC_PROTO/Compression:COMPRESSION_IDENTITY/TLS:false/unary/success",
      "Duplicate Metadata/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/Codec:CODEC_JSON/Compression:COMPRESSION_IDENTITY/TLS:false/unary/error",
      "Duplicate Metadata/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/Codec:CODEC_JSON/Compression:COMPRESSION_IDENTITY/TLS:false/unary/success",
      "Duplicate Metadata/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/Codec:CODEC_PROTO/Compression:COMPRESSION_IDENTITY/TLS:false/unary/error",
      "Duplicate Metadata/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/Codec:CODEC_PROTO/Compression:COMPRESSION_IDENTITY/TLS:false/unary/success",
      "Server Empty Requests/HTTPVersion:1/Protocol:PROTOCOL_CONNECT/TLS:false/unary/empty-request"
    ]
  }
];

for (const testCase of cases) {
  const result = spawnSync(
    runner,
    [
      "--mode", "server",
      "--conf", config,
      "--max-servers", "1",
      "--",
      testCase.command,
      ...testCase.args
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const summary = `${testCase.expected.passed} passed, ${testCase.expected.failed} failed`;
  if (result.status !== testCase.expected.status || !output.includes(summary)) {
    throw new Error(
      `${testCase.name} conformance mismatch (status ${result.status}, expected ${testCase.expected.status}; expected ${summary})\n${output}`
    );
  }
  const failures = [...output.matchAll(/^FAILED: (.+):$/gm)].map((match) => match[1]);
  const expectedFailures = testCase.expectedFailures ?? [];
  if (JSON.stringify(failures) !== JSON.stringify(expectedFailures)) {
    throw new Error(
      `${testCase.name} failure cases changed\nexpected: ${JSON.stringify(expectedFailures)}\nactual: ${JSON.stringify(failures)}\n${output}`
    );
  }
  process.stdout.write(`${testCase.name}: ${summary}\n`);
}

function checkout(directory, url, ref) {
  if (!existsSync(join(directory, ".git"))) {
    mkdirSync(directory, { recursive: true });
    run("git", ["init", "--quiet"], { cwd: directory });
    run("git", ["remote", "add", "origin", url], { cwd: directory });
  }
  const current = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8"
  });
  if (current.status === 0 && current.stdout.trim() === ref) {
    return;
  }
  run("git", ["fetch", "--quiet", "--depth", "1", "origin", ref], {
    cwd: directory
  });
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
    cwd: directory
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`
    );
  }
  return result;
}
