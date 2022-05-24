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
    const { executable, args, cwd, onExit } = options;

    try {
      fs.accessSync(executable, fs.constants.X_OK);
    } catch (err) {
      throw new Error(
        `The emulator executable '${executable}' is not executable`
      );
    }

    return new Promise((resolve, reject) => {
      this.childProcess = cp.spawn(executable, args, { cwd });
      this.childProcess.on("exit", () => {
        if (onExit) {
          onExit();
        }
        this.childProcess = undefined;
      });
      this.childProcess.on("spawn", resolve);
      this.childProcess.on("error", reject);
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
