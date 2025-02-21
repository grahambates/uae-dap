import { logger } from "@vscode/debugadapter";
import * as cp from "child_process";
import * as fs from "fs";
import { dirname, join, resolve } from "path";
import { findBinDir } from "./utils/files";

export interface RunOptions {
  /** Emulator executable binary */
  bin?: string;
  /** Additional CLI args to pass to emulator program. Remote debugger args are added automatically */
  args: string[];
  /** local filesystem path of rom to run - either a zip file or folder */
  rom?: string;
  /** Directory in which to look for roms - if not specified, the directory part of the path specified for rom will be used */
  rompath?: string;
  /** Callback executed on process exit */
  onExit?: () => void;
}

export interface DebugOptions extends RunOptions {
  serverPort: number;
}

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
    const bin = customBin || defaultBin;

    const args = [...opts.args, ...this.runArgs(opts)];
    const env = process.env;

    logger.log(`[EMU] Starting emulator: ${bin} ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      this.childProcess = cp.spawn(bin, args, { env });
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
 * Mame emulator program
 */
export class Mame extends Emulator {
  protected defaultBin(): string {
    // Just assume mame is in user's path
    let bin = "mame";
    if (isWin) {
      bin += ".exe";
    }
    return bin;
  }

  protected runArgs(opts: RunOptions): string[] {
    const args = [];
    if (opts.rompath && !opts.args.some((v) => v.startsWith("-rompath"))) {
      // resolves to absolute path, mame doesn't like relative
      args.push("-rompath", resolve(opts.rompath));
    }
    if (opts.rom) {
      args.push(opts.rom);
    }
    return args;
  }

  protected debugArgs(opts: DebugOptions): string[] {
    const args = [];
    if (!opts.args.some((v) => v == "-debug")) {
      args.push("-debug");
    }
    if (!opts.args.some((v) => v.startsWith("-debugger "))) {
      args.push("-debugger", "gdbstub");
    }
    if (!opts.args.some((v) => v.startsWith("-debugger_port"))) {
      args.push("-debugger_port", opts.serverPort.toString());
    }
    return args;
  }
}
