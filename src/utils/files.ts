import * as path from "path";
import * as fs from "fs";
import { access } from "fs/promises";

export function areSameSourceFileNames(
  sourceA: string,
  sourceB: string
): boolean {
  if (path.isAbsolute(sourceA) && path.isAbsolute(sourceB)) {
    if (process.platform === "win32") {
      return (
        path.normalize(sourceA).toLowerCase() ===
        path.normalize(sourceB).toLowerCase()
      );
    } else {
      return path.normalize(sourceA) === path.normalize(sourceB);
    }
  }
  if (process.platform === "win32") {
    return (
      path.basename(sourceB).toLowerCase() ===
      path.basename(sourceA).toLowerCase()
    );
  } else {
    return path.basename(sourceB) === path.basename(sourceA);
  }
}

/**
 * Normalizes a path
 * @param inputPath Path to normalize
 * @return Normalized path
 */
export function normalize(inputPath: string): string {
  let newDName = inputPath.replace(/\\+/g, "/");
  // Testing Windows derive letter -> to uppercase
  if (newDName.length > 0 && newDName.charAt(1) === ":") {
    const fChar = newDName.charAt(0).toUpperCase();
    newDName = fChar + ":" + newDName.substring(2);
  }
  return newDName;
}

export async function exists(file: string) {
  return access(file, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);
}

let wasmDir: string | undefined;

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
