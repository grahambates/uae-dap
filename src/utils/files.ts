import * as path from "path";
import * as fs from "fs";

let wasmDir: string | undefined;
let binDir: string | undefined;

export function findWasmDir(): string {
  if (wasmDir) {
    return wasmDir;
  }
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    wasmDir = path.join(dir, "wasm");
    if (fs.existsSync(wasmDir)) {
      return wasmDir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("wasm dir not found");
}

export function findBinDir(): string {
  if (binDir) {
    return binDir;
  }
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    binDir = path.join(dir, "bin");
    if (fs.existsSync(binDir)) {
      return binDir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("bin dir not found");
}
