import * as cp from "child_process";
import * as path from "path";

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
