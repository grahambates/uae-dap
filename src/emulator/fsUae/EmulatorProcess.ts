/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ChildProcess, spawn } from "child_process";
import EventEmitter from "events";
import { Mutex } from "async-mutex";

export interface EmulatorProcessOptions {
  /**
   * Current working directory
   */
  cwd?: string;
  /**
   * Pipe input/output to stdout?
   */
  pipe?: boolean;
}

const DEFAULT_TIMEOUT = 5000;

/**
 * Runs the fs-uae executable and handles IO to run debug console commands
 */
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
    this.pipe = pipe;
    this.mutex = new Mutex();

    // Start the emulator process
    this.process = spawn(emulatorExe, args, { cwd });

    // Emit a 'ready' event when the command prompt is present
    this.readOutput().then(() => this.emit("ready"));

    this.process.on("exit", () => this.emit("exit"));

    // Optionally pipe all input and output from process to emulator:
    // Allows console to be visible and interactive in the terminal
    if (pipe) {
      this.process.stderr!.pipe(process.stdout);
      this.process.stdout!.pipe(process.stdout);
      process.stdin.pipe(this.process.stdin!);
    }
  }

  /**
   * Execute a text command in the debug console
   */
  async executeCommand(
    cmd: string,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<string> {
    // Use mutex as this obviously can't be done in parallel
    return this.mutex.runExclusive(async () => {
      if (this.pipe) {
        process.stdout.write(cmd + "\n");
      }
      this.process.stdin!.write(cmd + "\n");
      return this.readOutput(timeoutMs);
    });
  }

  /**
   * Read output on the console and wait for the command prompt to return
   */
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

  /**
   * Exits the running program to the debugger console
   */
  pause() {
    this.process.kill("SIGINT");
  }

  /**
   * Kills the emulator process
   */
  terminate() {
    this.process.kill();
  }
}
