#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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
  const wasi = new WASI({
    version: "preview1",
    args: ["cmdproto", ...args],
    preopens: {
      "/": "/"
    },
    stdin: 0,
    stdout: 1,
    stderr: 2
  });
  const moduleBytes = readFileSync(resolvedPath);
  const module = await WebAssembly.compile(moduleBytes);
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  wasi.start(instance);
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
