import * as cp from "child_process";
import * as fs from "fs";

interface EmulatorOptions {
  /** Emulator executable binary */
  executable: string;
  /** CLI args to pass on run */
  args: string[];
  /** Current directory */
  cwd?: string;
  /** Callback executed on process exit */
  onExit?: () => void;
  /** Callback executed on stdout/stderr */
  onOutput?: (data: Buffer) => void;
}

/**
 * Wrpper for FS-UAE / WinUAE process
 */
export class Emulator {
  private childProcess?: cp.ChildProcess;

  /**
   * Start emulator process
   */
  public run(options: EmulatorOptions): Promise<void> {
    const { executable, args, cwd, onExit, onOutput: onData } = options;

    try {
      fs.accessSync(executable, fs.constants.X_OK);
    } catch (err) {
      throw new Error(
        `The emulator executable '${executable}' is not executable`
      );
    }

    return new Promise((resolve, reject) => {
      this.childProcess = cp.spawn(executable, args, { cwd });
      this.childProcess.once("exit", () => {
        if (onExit) {
          onExit();
        }
        this.childProcess = undefined;
      });
      this.childProcess.once("spawn", resolve);
      this.childProcess.once("error", reject);
      if (onData) {
        this.childProcess.stdout?.on("data", onData);
        this.childProcess.stderr?.on("data", onData);
      }
    });
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
