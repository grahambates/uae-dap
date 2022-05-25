import * as cp from "child_process";
import * as path from "path";
import { basename } from "path";
import { openSync } from "temp";
import * as fs from "fs/promises";
import { SourceConstantResolver } from "./program";
import { findWasmDir } from "./utils/files";

export interface VasmOptions {
  /** Enable extracting constants from source files using vasm */
  parseSource?: boolean;
  /** vasm binary - will use wasm if not set */
  binaryPath?: string;
  /** additional cli args for vasm - add include paths etc */
  args?: string[];
}

/**
 * Wrapper for vasm assembler
 */
export default class Vasm {
  constructor(private binPath?: string) {}

  /**
   * RUn assembler
   *
   * @param args CLI arguments to pass to process
   * @param cwd Current directory to execute process in
   */
  public run(args: string[], cwd?: string): Promise<string> {
    const options: cp.SpawnOptionsWithoutStdio = {
      cwd,
      stdio: "pipe",
    };

    const wasmPath = path.join(findWasmDir(), "vasmm68k_mot");

    // Execute vasm via binary or wasm
    const proc = this.binPath
      ? cp.spawn(this.binPath, args, options)
      : cp.fork(wasmPath, args, {
          ...options,
          // Prevent the child process from also being started in inspect mode
          // See https://github.com/nodejs/node/issues/14325
          execArgv: [],
        });

    proc.stdout?.on("data", (data) => (out += data));
    proc.stderr?.on("data", (data) => (out += data));

    let out = "";

    return new Promise((resolve, reject) => {
      proc.on("exit", () => resolve(out));
      proc.on("error", reject);
    });
  }
}

/**
 * Uses vasm to assemble the process in 'test' mode to list definitions
 */
export class VasmSourceConstantResolver implements SourceConstantResolver {
  constructor(private vasmOptions: VasmOptions = {}) {}

  /**
   * @inheritdoc
   */
  public async getSourceConstants(
    sourceFiles: string[]
  ): Promise<Record<string, number>> {
    const constants: Record<string, number> = {};
    if (this.vasmOptions?.parseSource === false) {
      return constants;
    }

    // Use vasm 'test' output module to list constants
    const vasm = new Vasm(this.vasmOptions?.binaryPath);
    await Promise.all(
      Array.from(sourceFiles).map(async (src) => {
        const outFile = openSync(basename(src));
        const userArgs = this.vasmOptions?.args ?? [];
        try {
          await vasm.run([
            ...userArgs,
            "-Ftest",
            "-quiet",
            "-o",
            outFile.path,
            src,
          ]);
          const output = (await fs.readFile(outFile.path)).toString();
          Array.from(
            output.matchAll(
              /^([^ ]+) EXPR\((-?[0-9]+)=0x[0-9a-f]+\) (UNUSED )?EQU/gm
            )
          ).forEach((m) => (constants[m[1]] = parseInt(m[2], 10)));
        } finally {
          fs.unlink(outFile.path);
        }
      })
    );

    return constants;
  }
}
