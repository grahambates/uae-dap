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

const isWin = process.platform === "win32";

/**
 * Base emulator class
 */
export abstract class Emulator {
  /**
   * Running emulator process
   */
  private childProcess?: cp.ChildProcess;

  /**
   * Return default path for emulator binary for platform
   */
  protected abstract defaultBin(): string;

  /**
   * Generated args to pass when running
   */
  protected abstract runArgs(opts: RunOptions): string[];

  /**
   * Generated args to pass when debugging
   */
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
      default:
        throw new Error("Unsupported emulator type " + type);
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
    const customBin = opts.bin;
    const defaultBin = this.defaultBin();
    let bin = customBin || defaultBin;
    if (customBin && !this.checkBin(customBin)) {
      logger.warn("Defaulting to bundled emulator binary");
      bin = defaultBin;
    }
    if (!this.checkBin(bin)) {
      throw new Error("[EMU] No suitable emulator binary");
    }

    const cwd = dirname(bin);
    const args = [...opts.args, ...this.runArgs(opts)];
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: ".", // Allow Linux fs-uae to find bundled .so files
    };

    logger.log(`[EMU] Starting emulator: ${bin} ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      this.childProcess = cp.spawn(bin, args, { cwd, env });
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

  /**
   * Check suitablity of emulator binary path
   */
  protected checkBin(bin: string): boolean {
    // Ensure binary file exists
    if (!fs.existsSync(bin)) {
      logger.error(`Emulator binary not found at '${bin}'`);
      return false;
    }
    // Ensure binary is executable for POSIX
    if (!isWin) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
      } catch (_) {
        logger.log(
          "Emulator binary '${executable}' not executable - trying to chmod"
        );
        try {
          fs.chmodSync(bin, 0o755);
        } catch (_) {
          logger.error(
            `The emulator binary '${bin}' is not executable and permissions could not be changed`
          );
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Terminate process
   */
  public destroy() {
    if (this.childProcess) {
      if (!this.childProcess.kill("SIGKILL")) {
        logger.log(`The emulator could not be stopped with SIGKILL`);
        if (this.childProcess.pid) {
          logger.log(`Killing process`);
          process.kill(-this.childProcess.pid);
        }
      }
      this.childProcess = undefined;
    }
  }
}

/**
 * FS-UAE emaultor program
 */
export class FsUAE extends Emulator {
  protected defaultBin(): string {
    const binDir = findBinDir();

    // Choose default binary based on platform
    let bin = join(binDir, "fs-uae", `fs-uae-${process.platform}_x64`);
    if (isWin) {
      bin += ".exe";
    }
    return bin;
  }

  protected checkBin(bin: string): boolean {
    const valid = super.checkBin(bin);
    if (!valid) {
      return false;
    }
    // Check version string to ensure correct patched version
    const cwd = dirname(bin);
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: ".", // Allow Linux fs-uae to find bundled .so files
    };
    const output = cp.spawnSync(bin, ["--version"], { cwd, env });
    const version = output.stdout.toString().trim();
    logger.log("[EMU] Version: " + version);
    if (!version.includes("remote_debug")) {
      logger.warn(
        "FS-UAE must be patched 4.x version. Ensure you're using the latest binaries."
      );
      return false;
    }
    return true;
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
      args.push("--remote_debugger=60");
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

/**
 * WinUAE Emulator program
 */
export class WinUAE extends Emulator {
  protected defaultBin(): string {
    const binDir = findBinDir();
    return join(binDir, "winuae", `winuae.exe`);
  }

  protected checkBin(bin: string): boolean {
    if (!isWin) {
      logger.warn("WinUAE only supported on Windows");
      return false;
    }
    return super.checkBin(bin);
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
    if (!opts.args.some((v) => v.startsWith("debugging_features"))) {
      args.push("-s", "debugging_features=gdbserver");
    }
    if (!opts.args.some((v) => v.startsWith("debugging_trigger"))) {
      args.push("-s", "debugging_trigger=" + opts.remoteProgram);
    }
    return args;
  }
}
