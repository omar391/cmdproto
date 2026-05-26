#!/usr/bin/env node

import { closeSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message = typeof warning === "string" ? warning : warning?.message ?? "";
  if (String(message).includes("WASI is an experimental feature")) {
    return;
  }
  return originalEmitWarning(warning, ...args);
};

export async function runWasiModule(wasmPath, args) {
  const { WASI } = await import("node:wasi");
  const resolvedPath = isAbsolute(wasmPath)
    ? wasmPath
    : resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), wasmPath);
  let stdin = 0;
  let cleanup = () => {};
  if (args[0] === "check") {
    const stdinPath = join(tmpdir(), `cmdproto-wasi-stdin-${process.pid}-${Date.now()}`);
    writeFileSync(stdinPath, readFileSync(0));
    stdin = openSync(stdinPath, "r");
    cleanup = () => {
      closeSync(stdin);
      rmSync(stdinPath, { force: true });
    };
  }
  const wasi = new WASI({
    version: "preview1",
    args: ["cmdproto", ...args],
    preopens: {
      "/": "/"
    },
    stdin,
    stdout: 1,
    stderr: 2
  });
  try {
    const moduleBytes = readFileSync(resolvedPath);
    const module = await WebAssembly.compile(moduleBytes);
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    wasi.start(instance);
  } finally {
    cleanup();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [wasmPath, ...args] = process.argv.slice(2);
  if (!wasmPath) {
    process.stderr.write("Usage: node scripts/run-wasi.mjs <wasm-path> [args...]\n");
    process.exitCode = 2;
  } else {
    await runWasiModule(wasmPath, args);
  }
}
