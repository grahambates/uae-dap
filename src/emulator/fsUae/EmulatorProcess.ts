/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ChildProcess, spawn } from "child_process";
import EventEmitter from "events";
import { Mutex } from "async-mutex";

export interface EmulatorProcessOptions {
  cwd?: string;
  pipe?: boolean;
}

const DEFAULT_TIMEOUT = 5000;

export class EmulatorProcess extends EventEmitter {
  private process: ChildProcess;
  private pipe = false;
  private mutex = new Mutex();

  constructor(
    emulatorExe: string,
    args: string[],
    options: EmulatorProcessOptions = {}
  ) {
    super();
    const { cwd, pipe = false } = options;
    this.process = spawn(emulatorExe, args, { cwd });
    this.pipe = pipe;
    this.mutex = new Mutex();

    this.readOutput().then(() => this.emit("ready"));
    this.process.on("exit", () => {
      this.emit("exit");
    });

    // Pipe all input and output from process to emulator:
    // Allows console to be visible and interactive in the terminal
    if (pipe) {
      this.process.stderr!.pipe(process.stdout);
      this.process.stdout!.pipe(process.stdout);
      process.stdin.pipe(this.process.stdin!);
    }
  }

  async executeCommand(
    cmd: string,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<string> {
    return this.mutex.runExclusive(async () => {
      if (this.pipe) {
        process.stdout.write(cmd + "\n");
      }
      this.process.stdin!.write(cmd + "\n");
      return this.readOutput(timeoutMs);
    });
  }

  readOutput(timeoutMs?: number): Promise<string> {
    let output = "";
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout;
      if (timeoutMs) {
        // Reject if output not finished after timeout
        timeout = setTimeout(() => {
          this.process.stdout!.off("data", handleData);
          this.process.stderr!.off("data", handleData);
          reject(new Error("Timeout waiting for output"));
        }, timeoutMs);
      }

      const handleData = (chunk: Buffer) => {
        output += chunk.toString();
        // Keep appending output until we see the command prompt
        if (output.endsWith(">")) {
          clearTimeout(timeout);
          // Output from seglist comes on stdout and might be in the wrong order
          setTimeout(() => {
            this.process.stdout!.off("data", handleData);
            this.process.stderr!.off("data", handleData);
            resolve(output);
          });
        }
      };
      this.process.stdout!.on("data", handleData);
      this.process.stderr!.on("data", handleData);
    });
  }

  terminate() {
    this.process.kill();
  }
}
