import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, "scripts", "cmdproto.mjs");

function build(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, [CLI, "build", "--cwd", cwd, ...args], {
    encoding: "utf8"
  });
}

function makeCheckout() {
  const root = mkdtempSync(join(tmpdir(), "cmdproto-cache-"));
  mkdirSync(join(root, "proto", "cmdproto", "v1"), { recursive: true });
  for (const file of ["options.proto", "runtime.proto"]) {
    cpSync(
      join(REPO_ROOT, "proto", "cmdproto", "v1", file),
      join(root, "proto", "cmdproto", "v1", file)
    );
  }
  writeFileSync(
    join(root, "buf.yaml"),
    "version: v2\nmodules:\n  - path: proto\nlint:\n  use:\n    - STANDARD\n"
  );
  return root;
}

function cacheDir(cwd: string) {
  return join(cwd, "node_modules", ".cache", "cmdproto", "build");
}

function cacheRecords(cwd: string) {
  const dir = cacheDir(cwd);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
}

function digest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("cmdproto build cache", () => {
  it("reuses a verified build on the second run", () => {
    const root = makeCheckout();
    try {
      const cold = build(root, ["--app-name", "cached"]);
      assert.equal(cold.status, 0, cold.stderr);
      assert.doesNotMatch(cold.stdout, /cache hit/);

      const warm = build(root, ["--app-name", "cached"]);
      assert.equal(warm.status, 0, warm.stderr);
      assert.match(warm.stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keys on proto content, not the reported path list", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "content"]).status, 0);
      const schemaBefore = digest(join(root, "dist", "schema.binpb"));

      const proto = join(root, "proto", "cmdproto", "v1", "options.proto");
      const original = readFileSync(proto, "utf8");
      writeFileSync(
        proto,
        original.replace('edition = "2024";', 'edition = "2023";')
      );

      const after = build(root, ["--app-name", "content"]);
      assert.equal(after.status, 0, after.stderr);
      assert.doesNotMatch(after.stdout, /cache hit/);
      assert.notEqual(digest(join(root, "dist", "schema.binpb")), schemaBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keys on the app name", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "one"]).status, 0);
      const first = build(root, ["--app-name", "two"]);
      assert.equal(first.status, 0, first.stderr);
      assert.doesNotMatch(first.stdout, /cache hit/);
      assert.match(build(root, ["--app-name", "one"]).stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuilds when the buf config changes", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "cfg"]).status, 0);
      const config = join(root, "buf.yaml");
      writeFileSync(config, readFileSync(config, "utf8") + "breaking:\n  use:\n    - FILE\n");
      const after = build(root, ["--app-name", "cfg"]);
      assert.equal(after.status, 0, after.stderr);
      assert.doesNotMatch(after.stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuilds when an output is modified or removed", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "outputs"]).status, 0);
      const schema = join(root, "dist", "schema.binpb");
      const good = readFileSync(schema);

      writeFileSync(schema, Buffer.concat([Buffer.from("corrupt"), good.subarray(7)]));
      const tampered = build(root, ["--app-name", "outputs"]);
      assert.equal(tampered.status, 0, tampered.stderr);
      assert.doesNotMatch(tampered.stdout, /cache hit/);
      assert.deepEqual(readFileSync(schema), good);

      rmSync(join(root, "dist", "runtime.binpb"));
      const missing = build(root, ["--app-name", "outputs"]);
      assert.equal(missing.status, 0, missing.stderr);
      assert.doesNotMatch(missing.stdout, /cache hit/);
      assert.ok(existsSync(join(root, "dist", "runtime.binpb")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a malformed record as a miss", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "malformed"]).status, 0);
      const [record] = cacheRecords(root);
      writeFileSync(join(cacheDir(root), record), "{ not json");
      const after = build(root, ["--app-name", "malformed"]);
      assert.equal(after.status, 0, after.stderr);
      assert.doesNotMatch(after.stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a record from another schema version as a miss", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "versioned"]).status, 0);
      const [name] = cacheRecords(root);
      const record = JSON.parse(readFileSync(join(cacheDir(root), name), "utf8"));
      record.schema = 999;
      writeFileSync(join(cacheDir(root), name), JSON.stringify(record));
      const after = build(root, ["--app-name", "versioned"]);
      assert.equal(after.status, 0, after.stderr);
      assert.doesNotMatch(after.stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forces a full build with --no-cache and refreshes the record", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "forced"]).status, 0);
      const forced = build(root, ["--app-name", "forced", "--no-cache"]);
      assert.equal(forced.status, 0, forced.stderr);
      assert.doesNotMatch(forced.stdout, /cache hit/);
      assert.match(build(root, ["--app-name", "forced"]).stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds without caching when buf config cannot be fingerprinted", () => {
    const root = makeCheckout();
    try {
      writeFileSync(
        join(root, "buf.yaml"),
        "version: v2\nmodules:\n  - path: proto\nlint:\n  use:\n    - STANDARD\ndeps:\n  - buf.build/cmdproto/options\n"
      );
      const first = build(root, ["--app-name", "unfingerprintable"]);
      assert.equal(first.status, 0, first.stderr);
      assert.doesNotMatch(first.stdout, /cache hit/);
      assert.deepEqual(cacheRecords(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves no record when lint fails", () => {
    const root = makeCheckout();
    try {
      writeFileSync(join(root, "proto", "cmdproto", "v1", "bad.proto"), "syntax error here\n");
      const failed = build(root, ["--app-name", "lintfail"]);
      assert.notEqual(failed.status, 0);
      assert.deepEqual(cacheRecords(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("produces byte-identical outputs for identical inputs", () => {
    const root = makeCheckout();
    try {
      build(root, ["--app-name", "determinism", "--no-cache"]);
      const first = {
        schema: digest(join(root, "dist", "schema.binpb")),
        runtime: digest(join(root, "dist", "runtime.binpb"))
      };
      build(root, ["--app-name", "determinism", "--no-cache"]);
      const second = {
        schema: digest(join(root, "dist", "schema.binpb")),
        runtime: digest(join(root, "dist", "runtime.binpb"))
      };
      assert.deepEqual(second, first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps --generate-only free of schema caching", () => {
    const root = makeCheckout();
    writeFileSync(join(root, "buf.gen.yaml"), "version: v2\nplugins: []\n");
    try {
      const only = build(root, ["--app-name", "genonly", "--generate-only"]);
      assert.equal(only.status, 0, only.stderr);
      assert.doesNotMatch(only.stdout, /cache hit/);
      assert.deepEqual(cacheRecords(root), []);
      assert.equal(existsSync(join(root, "dist", "schema.binpb")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declines caching when a listed proto file cannot be hashed", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "unreadable"]).status, 0);
      assert.match(build(root, ["--app-name", "unreadable"]).stdout, /cache hit/);

      // An input that vanishes must not be dropped from the key: dropping it
      // would let a later hit skip a build whose input is gone.
      rmSync(join(root, "proto", "cmdproto", "v1", "options.proto"));
      const after = build(root, ["--app-name", "unreadable"]);
      assert.doesNotMatch(after.stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keys on a configured local plugin's bytes", () => {
    const root = makeCheckout();
    const plugin = join(root, "scripts", "buf-plugin-cmdproto");
    try {
      // Mirror the real plugin next to its runner and WASM image so buf lint
      // succeeds, then confirm the recorded key carries that plugin's bytes.
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "dist", "wasm"), { recursive: true });
      cpSync(join(REPO_ROOT, "scripts", "buf-plugin-cmdproto"), plugin);
      cpSync(join(REPO_ROOT, "scripts", "run-wasi.mjs"), join(root, "scripts", "run-wasi.mjs"));
      cpSync(
        join(REPO_ROOT, "dist", "wasm", "cmdproto-buf-plugin.wasm"),
        join(root, "dist", "wasm", "cmdproto-buf-plugin.wasm")
      );
      chmodSync(plugin, 0o755);
      writeFileSync(
        join(root, "buf.yaml"),
        "version: v2\nmodules:\n  - path: proto\nlint:\n  use:\n    - CMDPROTO\nplugins:\n  - plugin: ./scripts/buf-plugin-cmdproto\n"
      );

      assert.equal(build(root, ["--app-name", "plug"]).status, 0);
      assert.match(build(root, ["--app-name", "plug"]).stdout, /cache hit/);

      const parsed = JSON.parse(
        readFileSync(join(cacheDir(root), cacheRecords(root)[0]), "utf8")
      );
      assert.equal(
        parsed.fingerprint.plugins[0].digest,
        createHash("sha256").update(readFileSync(plugin)).digest("hex")
      );

      writeFileSync(plugin, `${readFileSync(plugin, "utf8")}\n# changed\n`);
      const after = build(root, ["--app-name", "plug"]);
      assert.doesNotMatch(after.stdout, /cache hit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declines caching when a configured plugin cannot be hashed", () => {
    const root = makeCheckout();
    try {
      writeFileSync(
        join(root, "buf.yaml"),
        "version: v2\nmodules:\n  - path: proto\nlint:\n  use:\n    - STANDARD\nplugins:\n  - plugin: ./missing-plugin.sh\n"
      );
      // buf cannot run this plugin either, so the build fails. What matters
      // is that no record is left behind for a config we cannot fingerprint.
      const built = build(root, ["--app-name", "missingplug"]);
      assert.notEqual(built.status, 0);
      assert.deepEqual(cacheRecords(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keys on the WASI runner used by the plugin and manifest tools", () => {
    const root = makeCheckout();
    try {
      assert.equal(build(root, ["--app-name", "wasi"]).status, 0);
      assert.match(build(root, ["--app-name", "wasi"]).stdout, /cache hit/);

      const record = cacheRecords(root)[0];
      const parsed = JSON.parse(readFileSync(join(cacheDir(root), record), "utf8"));
      assert.ok(
        parsed.fingerprint.tools.wasiRunner,
        "fingerprint must cover scripts/run-wasi.mjs"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
