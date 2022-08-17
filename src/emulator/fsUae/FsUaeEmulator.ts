/* eslint-disable @typescript-eslint/no-non-null-assertion */
import EventEmitter from "events";
import { basename } from "path";

import {
  Emulator,
  Registers,
  EmulatorOptions,
  EmulatorRunOptions,
  Segment,
  AReg,
  DReg,
  Vector,
  CIAs,
} from "..";
import { EmulatorProcess } from "./EmulatorProcess";
import {
  parseCia,
  parseStop,
  parseCustom,
  parseSegList,
  parseVectors,
  parseRegisters,
  parseMemoryDump,
} from "./outputParsing";

const START_TIMEOUT = 10000;

export interface FsUaeEmulatorOptions extends EmulatorOptions {
  pipe?: boolean;
}

export class FsUaeEmulator extends EventEmitter implements Emulator {
  private breakpoints = new Set<number>();
  private registers: Registers | null = null;
  private entrySp = 0;
  private stopped = false;
  private program: string | null = null;

  /**
   * Create instance with running program
   */
  static async create(options: FsUaeEmulatorOptions): Promise<FsUaeEmulator> {
    const {
      exe,
      args,
      cwd,
      program,
      pipe = false,
      stopOnEntry = true,
      stopOnException = true,
    } = options;
    const process = new EmulatorProcess(exe, args, { cwd, pipe });
    const instance = new FsUaeEmulator(process);
    await instance.runProgram(program, {
      stopOnEntry,
      stopOnException,
    });
    return instance;
  }

  constructor(private process: EmulatorProcess) {
    super();

    this.process.on("exit", () => {
      this.emit("exit");
      this.program = null;
    });
  }

  async runProgram(
    program: string,
    { stopOnEntry = true, stopOnException = true }: EmulatorRunOptions = {}
  ) {
    this.program = program;
    this.stopped = true;

    // Wait for command prompt:
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            "Timeout waiting for emulator process to be ready for input"
          )
        );
      }, START_TIMEOUT);
      this.process.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Enable seglist tracker:
    // Ze [<0-1>]            enable/disable/toggle SegmentTracker
    await this.executeCommand("Ze");

    // Go to start of program:
    // fp "<name>"/<addr>    Step forward until process <name> or <addr> is active.
    const status = await this.executeCommand(`fp "${program}"`);
    this.processStatus(status);
    this.entrySp = this.registers!.A7; // Track stack position on entry

    // Zf 'hostfile'         load debug info from given executable file.
    const filename = basename(this.program.replace(/\w+:/, ""));
    await this.executeCommand(`Zf "${filename}"`);

    if (stopOnException) {
      // il [<mask>]           Exception breakpoint.
      return this.executeCommand(`il`);
    }

    this.emit("start");

    if (!stopOnEntry) {
      this.continue();
    }
  }

  terminate(): void {
    this.process.terminate();
  }

  async stackTrace(): Promise<number[]> {
    let sp = this.registers!.A7;
    const stack = [];
    while (sp < this.entrySp) {
      const buf = await this.readMemory(sp, 4);
      stack.unshift(buf.readUInt32BE());
      // TODO:
      // check previous opcode for JSR/BSR?
      sp += 4;
    }
    return stack;
  }

  async getCopperPointer(): Promise<number> {
    // c                     Dump state of the CIA, disk drives and custom registers.
    const output = await this.executeCommand("c");
    const match = output.match(/COPPTR: ([0-9a-f]{8})/i);
    if (!match) {
      throw new Error("Copper pointer not found");
    }
    return parseInt(match[1], 16);
  }

  // Execution flow:

  async pause(): Promise<void> {
    this.stopped = true;
    this.process.stop();
  }

  async continue(): Promise<void> {
    this.stopped = false;

    // Wait for debug console to return when program next stops
    // g [<address>]         Start execution at the current address or <address>.
    return this.process.executeCommand("g", 0).then((status) => {
      // Update state
      this.processStatus(status);

      // Find out why the program stopped
      const reason = parseStop(status);
      if (reason.breakpoint) {
        this.emit("breakpoint", reason.breakpoint);
      } else if (reason.exception) {
        this.emit("exception", reason.exception);
      } else if (reason.watchpoint) {
        this.emit("watchpoint", reason.watchpoint);
      } else {
        this.emit("pause");
      }

      this.stopped = true;
    });
  }

  async next() {
    // t [instructions]      Step one or more instructions.
    const status = await this.executeCommand(`t`);
    this.processStatus(status);
  }

  async stepOver() {
    // z                     Step through one instruction - useful for JSR, DBRA etc.
    const status = await this.executeCommand(`z`);
    this.processStatus(status);
  }

  async stepOut() {
    // fi                    Step forward until PC points to RTS, RTD or RTE.
    await this.executeCommand(`fi`);
    // TODO: check stack trace
    return this.next();
  }

  // Breakpoints:

  async insertBreakpoint(address: number): Promise<void> {
    if (!this.breakpoints.has(address)) {
      this.breakpoints.add(address);
      // f <address>           Add/remove breakpoint.
      await this.executeCommand(`f ${address.toString(16)}`);
    }
  }

  async removeBreakpoint(address: number): Promise<void> {
    if (this.breakpoints.has(address)) {
      this.breakpoints.delete(address);
      // f <address>           Add/remove breakpoint.
      await this.executeCommand(`f ${address.toString(16)}`);
    }
  }

  async clearBreakpoints(): Promise<void> {
    // fd                    Remove all breakpoints.
    await this.executeCommand(`fd`);
  }

  async listBreakpoints(): Promise<number[]> {
    return Array.from(this.breakpoints.values());
  }

  async setExpectionBreakpoint(mask: number): Promise<void> {
    // il [<mask>]           Exception breakpoint.
    await this.executeCommand(`il ${mask.toString(16)}`);
  }

  // Watchpoints:

  // TODO:
  /*
    async def insert_watchpoint(self, addr, size, kind='I'):
        # w <num> <address> <length> <R/W/I/F/C> [<value>[.x]]
        #   (read/write/opcode/freeze/mustchange).
        # Add/remove memory watchpoints.

        # Watchpoints are deleted by numbers, so we need to maintain the <num>
        # for every watchpoint.
        index = max(self.watchpoints.values(), default=0) + 1
        self.watchpoints[addr, size, kind] = index
        lines = await self.communicate('w %d %X %d %s' %
                                       (index, addr, size, kind))
        assert lines and lines[-1] == 'Memwatch %d added' % index

    async def remove_watchpoint(self, addr, size, kind='I'):
        # w <num> <address> <length> <R/W/I/F/C> [<value>[.x]]
        #   (read/write/opcode/freeze/mustchange).
        # Add/remove memory watchpoints.
        index = self.watchpoints.pop((addr, size, kind))
        lines = await self.communicate('w %d' % index)
        assert lines and lines[-1] == 'Memwatch %d removed' % index
  */

  // Segments:

  async getSegments(): Promise<Segment[]> {
    // Zs 'name'             search seglist with given name.
    const output = await this.executeCommand(`Zs "${this.program}"`);
    return parseSegList(output);
  }

  // Registers:

  async getRegisters(): Promise<Registers> {
    if (!this.registers) {
      throw new Error("No registers");
    }
    // We should already have the register values from the status text each time the emulator stops
    // No need to read?
    return this.registers;
  }

  async setRegister(name: AReg | DReg, value: number): Promise<void> {
    this.registers![name] = value;
    await this.executeCommand(`r ${name} ${value.toString(16)}`);
  }

  async getCustom(): Promise<Record<string, number>> {
    // e                     Dump contents of all custom registers
    return this.executeCommand("e").then(parseCustom);
  }

  async getVectors(): Promise<Vector[]> {
    // i [<addr>]            Dump contents of interrupt and trap vectors.
    return this.executeCommand("i").then(parseVectors);
  }

  async getCia(): Promise<CIAs> {
    // c                     Dump state of the CIA, disk drives and custom registers.
    return this.executeCommand("c").then(parseCia);
  }

  // Memory:

  async readMemory(address: number, bytes: number): Promise<Buffer> {
    const rows = Math.ceil(bytes / 16);
    const output = await this.executeCommand(
      `m ${address.toString(16)} ${rows}`
    );
    return parseMemoryDump(output, bytes);
  }

  async writeMemory(address: number, buffer: Buffer): Promise<void> {
    const byteString = [...buffer.values()]
      .map((n) => n.toString(16))
      .join(" ");
    await this.executeCommand(`W ${address.toString(16)} ${byteString}`);
  }

  /**
   * Process the status text that is send whenever execution stops
   *
   * This is the same as the output from the 'r' command.
   */
  private processStatus(text: string): void {
    this.registers = parseRegisters(text);
  }

  /**
   * Execute a command on the running emulator process
   */
  async executeCommand(cmd: string): Promise<string> {
    if (!this.program) {
      throw new Error("Program not running");
    }
    if (!this.stopped) {
      await this.pause();
    }
    return this.process.executeCommand(cmd);
  }
}
