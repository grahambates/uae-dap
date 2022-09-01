import { logger } from "@vscode/debugadapter";
import * as cp from "child_process";
import * as fs from "fs";
import { dirname, join } from "path";
import { findBinDir } from "./utils/files";

export interface RunOptions {
  /** Emulator executable binary */
  bin?: string;
  /** Additional CLI args to pass to emulator program. Remote debugger args are added automatically */
  args: string[];
  /** Directory to mount as hard drive 0 (SYS) */
  mountDir?: string;
  /** Callback executed on process exit */
  onExit?: () => void;
}

export interface DebugOptions extends RunOptions {
  serverPort: number;
  remoteProgram: string;
}

export type EmulatorType = "fs-uae" | "winuae";

export abstract class Emulator {
  private childProcess?: cp.ChildProcess;

  protected abstract defaultBin(): string;
  protected abstract runArgs(opts: RunOptions): string[];
  protected abstract debugArgs(opts: DebugOptions): string[];

  /**
   * Factory
   */
  static getInstance(type: EmulatorType): Emulator {
    switch (type) {
      case "fs-uae":
        return new FsUAE();
      case "winuae":
        return new WinUAE();
    }
  }

  /**
   * Start emulator with remote debugger
   */
  public debug(opts: DebugOptions): Promise<void> {
    const args = [...opts.args, ...this.debugArgs(opts)];
    return this.run({ ...opts, args });
  }

  /**
   * Start emulator process
   */
  public run(opts: RunOptions): Promise<void> {
    const bin = opts.bin || this.defaultBin();
    this.checkBin(bin);

    const cwd = dirname(bin);
    const args = [...opts.args, ...this.runArgs(opts)];

    logger.log(`[EMU] Starting emulator: ${bin} ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      this.childProcess = cp.spawn(bin, args, { cwd });
      this.childProcess.once("spawn", resolve);
      this.childProcess.once("error", reject);
      this.childProcess.once("exit", () => {
        logger.log(`[EMU] Emulator quit`);
        if (opts.onExit) {
          opts.onExit();
        }
        this.childProcess = undefined;
      });
      const onData = (data: Buffer) =>
        logger.log("[EMU] " + data.toString().trim());
      this.childProcess.stdout?.on("data", onData);
      this.childProcess.stderr?.on("data", onData);
    });
  }

  protected checkBin(bin: string) {
    try {
      fs.existsSync(bin);
    } catch (err) {
      throw new Error(`Emulator binary not found at '${bin}'`);
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch (_) {
      logger.log(
        "Emulator binary '${executable}' not executable - trying to chmod"
      );
      try {
        fs.chmodSync(bin, 755);
      } catch (_) {
        throw new Error(
          `The emulator binary '${bin}' is not executable and permissions could not be changed`
        );
      }
    }
  }

  /**
   * Terminate process
   */
  public destroy() {
    if (this.childProcess) {
      this.childProcess.kill("SIGTERM");
      this.childProcess = undefined;
    }
  }
}

export class FsUAE extends Emulator {
  protected defaultBin(): string {
    const binDir = findBinDir();

    // Choose default binary based on platform
    const osMap = {
      darwin: "macos",
      linux: "debian",
      win32: "windows",
    };
    const os = osMap[process.platform as keyof typeof osMap];
    return join(binDir, "fs-uae", `fs-uae-${os}_x64`);
  }

  protected checkBin(bin: string) {
    super.checkBin(bin);
    const output = cp.execSync(bin + " --version");
    const version = output.toString().trim();
    logger.log("[EMU] Version: " + version);
    if (!version.includes("remote_debug")) {
      throw new Error(
        "FS-UAE must be patched 4.x version. Ensure you're using the latest binaries."
      );
    }
  }

  protected runArgs(opts: RunOptions): string[] {
    const args = [];
    if (
      opts.mountDir &&
      !opts.args.some((v) => v.startsWith("--hard_drive_0") || v.match(/.adf/i))
    ) {
      args.push("--hard_drive_0=" + opts.mountDir);
    }
    return args;
  }

  protected debugArgs(opts: DebugOptions): string[] {
    const args = [];
    if (!opts.args.some((v) => v.startsWith("--remote_debugger="))) {
      args.push("--remote_debugger=10000");
    }
    if (!opts.args.some((v) => v.startsWith("--remote_debugger_port"))) {
      args.push("--remote_debugger_port=" + opts.serverPort);
    }
    if (!opts.args.some((v) => v.startsWith("--remote_debugger_trigger"))) {
      args.push("--remote_debugger_trigger=" + opts.remoteProgram);
    }
    return args;
  }
}

export class WinUAE extends Emulator {
  protected defaultBin(): string {
    const binDir = findBinDir();
    return join(binDir, "winuae", `winuae.exe`);
  }

  protected checkBin(bin: string) {
    if (process.platform !== "win32") {
      throw new Error("WinUAE only supported on Windows");
    }
    super.checkBin(bin);
  }

  protected runArgs(opts: RunOptions): string[] {
    const args = [];
    if (
      opts.mountDir &&
      !opts.args.some((v) => v.startsWith("filesystem") || v.match(/.adf/i))
    ) {
      args.push("-s", "filesystem=rw,dh0:$" + opts.mountDir);
    }
    return args;
  }

  protected debugArgs(opts: DebugOptions): string[] {
    const args = [];
    if (!opts.args.some((v) => v.startsWith("--remote_debugger="))) {
      args.push("--remote_debugger=10000");
    }
    if (!opts.args.some((v) => v.startsWith("--remote_debugger_port"))) {
      args.push("--remote_debugger_port=" + opts.serverPort);
    }
    if (!opts.args.some((v) => v.startsWith("--remote_debugger_trigger"))) {
      args.push("--remote_debugger_trigger=" + opts.remoteProgram);
    }
    return args;
  }
}
