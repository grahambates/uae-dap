import * as cp from "child_process";
import * as path from "path";
import { basename } from "path";
import { openSync } from "temp";
import * as fs from "fs/promises";

export interface VasmOptions {
  /** Enable extracting constants from source files using vasm */
  parseSource?: boolean;
  /** vasm binary - will use wasm if not set */
  binaryPath?: string;
  /** additional cli args for vasm - add include paths etc */
  args?: string[];
}

const wasmPath =
  process.env.NODE_ENV === "test"
    ? path.join(__dirname, "..", "wasm", "vasmm68k_mot")
    : path.join(__dirname, "..", "..", "wasm", "vasmm68k_mot");

export default class Vasm {
  constructor(private binPath?: string) {}

  public run(args: string[], cwd?: string): Promise<string> {
    const options: cp.SpawnOptionsWithoutStdio = {
      cwd,
      stdio: "pipe",
    };
    // Execute vasm via binary or wasm
    const process = this.binPath
      ? cp.spawn(this.binPath, args, options)
      : cp.fork(wasmPath, args, options);

    process.stdout?.on("data", (data) => (out += data));
    process.stderr?.on("data", (data) => (out += data));

    let out = "";

    return new Promise((resolve, reject) => {
      process.on("exit", () => resolve(out));
      process.on("error", reject);
    });
  }
}

export class VasmSourceConstantResolver {
  constructor(private vasmOptions: VasmOptions = {}) {}

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
