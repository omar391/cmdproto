#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWasiModule } from "./run-wasi.mjs";

const ROOT_DIR = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..");
const CALLER_CWD = process.cwd();
const PATH_FLAGS = new Set(["--schema", "--out", "--out-json"]);

const forwardedArgs = [];
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  const [flag, inlineValue] = token.split("=", 2);

  if (PATH_FLAGS.has(flag)) {
    if (inlineValue !== undefined) {
      forwardedArgs.push(`${flag}=${resolve(CALLER_CWD, inlineValue)}`);
      continue;
    }

    forwardedArgs.push(token);
    const value = process.argv[index + 1];
    if (value) {
      forwardedArgs.push(resolve(CALLER_CWD, value));
      index += 1;
    }
    continue;
  }

  forwardedArgs.push(token);
}

await runWasiModule(join(ROOT_DIR, "dist/wasm/cmdproto-runtime-manifest.wasm"), forwardedArgs);
