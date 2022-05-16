import * as cp from "child_process";
import * as fs from "fs";

interface EmulatorOptions {
  executable?: string;
  cwd?: string;
  args: string[];
  onExit?: () => void;
}

export class Emulator {
  private childProcess?: cp.ChildProcess;

  public run(options: EmulatorOptions): Promise<void> {
    const { executable, args, cwd, onExit } = options;

    if (!executable) {
      throw new Error(
        "The emulator executable file path must be defined in the launch settings"
      );
    }

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

  public destroy() {
    if (this.childProcess) {
      this.childProcess.kill("SIGTERM");
      this.childProcess = undefined;
    }
  }
}
