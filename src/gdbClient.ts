import { Socket } from "net";
import { EventEmitter } from "events";
import { logger } from "@vscode/debugadapter";
import { Mutex } from "async-mutex";
import { hexStringToASCII } from "./utils/strings";

export interface HaltEvent {
  signal: HaltSignal;
  label: string;
  threadId?: number;
}

export enum HaltSignal {
  INT = 2,
  ILL = 4,
  TRAP = 5,
  EMT = 7,
  FPE = 8,
  BUS = 10,
  SEGV = 11,
}

export enum BreakpointCode {
  SOFTWARE = 0,
  HARDWARE = 1,
  WRITE = 2,
  READ = 3,
  ACCESS = 4,
}

type Events = {
  stop: (e: HaltEvent) => void;
  end: () => void;
  output: (message: string) => void;
};

export const DEFAULT_FRAME_INDEX = -1;
const TIMEOUT = 60000;

const signalLabels: Record<HaltSignal, string> = {
  [HaltSignal.INT]: "Interrupt",
  [HaltSignal.ILL]: "Illegal instruction",
  [HaltSignal.TRAP]: "Trace/breakpoint trap",
  [HaltSignal.EMT]: "Emulation trap",
  [HaltSignal.FPE]: "Arithmetic exception",
  [HaltSignal.BUS]: "Bus error",
  [HaltSignal.SEGV]: "Segmentation fault",
};

export class GdbClient {
  private socket: Socket;
  private requestMutex = new Mutex();
  private frameMutex = new Mutex();
  private eventEmitter: EventEmitter;
  private responseCallback?: (message: string) => void;
  private haltStatus: HaltEvent | undefined;

  constructor(socket?: Socket) {
    this.eventEmitter = new EventEmitter();
    this.socket = socket || new Socket();
    this.socket.on("data", this.handleData.bind(this));
  }

  public async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cb = async () => {
        try {
          logger.log("Connected: initializing");
          await this.request("QStartNoAckMode", true, "OK");
          resolve();
        } catch (error) {
          this.socket.destroy();
          this.socket = new Socket();
          reject(error);
        }
      };

      this.socket.once("error", () => {
        this.socket.off("ready", cb);
        reject();
      });

      this.socket.once("ready", cb);
      this.socket.connect(port, host);
    });
  }

  public destroy(): void {
    this.socket.destroy();
  }

  public async getOffsets(): Promise<number[]> {
    const res = await this.request("qOffsets");
    return res.split(";").map((a) => parseInt(a, 16));
  }

  // Breakpoints:

  public async setBreakpoint(
    address: number,
    type = BreakpointCode.SOFTWARE,
    size?: number
  ): Promise<void> {
    let message = `Z${type},${hex(address)}`;
    if (size !== undefined) {
      message += `,${hex(size)}`;
    }
    await this.request(message);
  }

  public async setExceptionBreakpoint(exceptionMask: number): Promise<void> {
    const expMskHex = hex(exceptionMask);
    const expMskHexSz = hex(expMskHex.length);
    await this.request("Z1,0,0;X" + expMskHexSz + "," + expMskHex);
  }

  public async removeBreakpoint(
    address: number,
    type = BreakpointCode.SOFTWARE,
    size?: number
  ): Promise<void> {
    let message = `z${type},${hex(address)}`;
    if (size !== undefined) {
      message += `,${hex(size)}`;
    }
    await this.request(message);
  }

  // Navigation:

  public async pause(threadId: number): Promise<void> {
    await this.request("vCont;t:" + threadId);
  }

  public async continueExecution(threadId: number): Promise<void> {
    await this.request("vCont;c:" + threadId, false);
  }

  public async stepIn(threadId: number): Promise<void> {
    await this.request("vCont;s:" + threadId);
  }

  public async stepToRange(
    threadId: number,
    startAddress: number,
    endAddress: number
  ): Promise<void> {
    await this.request(
      "vCont;r" + hex(startAddress) + "," + hex(endAddress) + ":" + threadId
    );
  }

  public async getHaltStatus(): Promise<HaltEvent | null> {
    if (this.haltStatus) {
      return this.haltStatus;
    }
    const response = await this.request("?");
    return response.indexOf("OK") < 0 ? this.parseHaltStatus(response) : null;
  }

  // Memory:

  public async readMemory(address: number, length: number): Promise<string> {
    return this.request("m" + hex(address) + "," + hex(length));
  }

  public async writeMemory(address: number, dataToSend: string): Promise<void> {
    const size = Math.ceil(dataToSend.length / 2);
    await this.request("M" + hex(address) + "," + size + ":" + dataToSend);
  }

  // Registers:

  public async getRegisters(threadId?: number | null): Promise<number[]> {
    const message = await this.request(threadId ? "Hg" + threadId : "g");
    const registers: number[] = [];

    const regCount = Math.floor(message.length / 8);
    for (let i = 0; i < regCount; i++) {
      const value = parseInt(message.substring(i * 8, (i + 1) * 8), 16);
      registers.push(value);
    }
    return registers;
  }

  public async getRegister(regIdx: number): Promise<number> {
    const data = await this.request("p" + hex(regIdx));
    return parseInt(data, 16);
  }

  public async setRegister(regIdx: number, value: string): Promise<string> {
    if (!value.match(/[a-z\d]{1,8}/i)) {
      throw new Error("The value must be a hex string with at most 8 digits");
    }
    const response = await this.request(
      "P" + regIdx.toString(16) + "=" + value
    );
    if (response && response.indexOf("OK") >= 0) {
      return value;
    } else {
      throw new Error("Error setting the register value");
    }
  }

  // Stack Frames:

  public async getFramesCount(): Promise<number> {
    const data = await this.request("qTStatus");
    const frameCountPosition = data.indexOf("tframes");
    if (frameCountPosition > 0) {
      let endFrameCountPosition = data.indexOf(";", frameCountPosition);
      if (endFrameCountPosition <= 0) {
        endFrameCountPosition = data.length;
      }
      const v = data.substring(frameCountPosition + 8, endFrameCountPosition);
      return parseInt(v, 16);
    }
    return 1;
  }

  public async selectFrame(frameIndex: number): Promise<number> {
    if (frameIndex < 0) {
      await this.request("QTFrame:ffffffff");
      return DEFAULT_FRAME_INDEX;
    }
    const data = await this.request("QTFrame:" + hex(frameIndex));

    if (data === "F-1") {
      // No frame found
      return DEFAULT_FRAME_INDEX;
    }
    let v = data.substring(1);
    const tPos = v.indexOf("T");
    if (tPos >= 0) {
      v = v.substring(0, tPos);
    }
    return parseInt(v, 16);
  }

  public async withFrame<T>(
    requestedFrame: number | undefined,
    cb: (returnedFrame: number) => Promise<T>
  ): Promise<T> {
    return this.frameMutex.runExclusive(async () => {
      if (requestedFrame === undefined) {
        requestedFrame = DEFAULT_FRAME_INDEX;
      }
      const returnedFrame = await this.selectFrame(requestedFrame);
      return cb(returnedFrame);
    });
  }

  // Commands:

  public async monitor(command: string): Promise<string> {
    const response = await this.request("qRcmd," + stringToHex(command));
    return response;
  }

  // Events:

  public on<U extends keyof Events>(event: U, listener: Events[U]): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  public once<U extends keyof Events>(event: U, listener: Events[U]): this {
    this.eventEmitter.once(event, listener);
    return this;
  }

  public off<U extends keyof Events>(event: U, listener: Events[U]): this {
    this.eventEmitter.off(event, listener);
    return this;
  }

  private sendEvent<U extends keyof Events>(
    event: U,
    ...args: Parameters<Events[U]>
  ): void {
    setImmediate(() => {
      this.eventEmitter.emit(event, ...args);
    });
  }

  // Socket IO:

  private async request(
    text: string,
    responseExpected = true,
    expectedResponse?: string
  ): Promise<string> {
    return this.requestMutex.runExclusive(async () => {
      const req = `$${text}#${calculateChecksum(text)}`;
      logger.log(`[GDB] --> ${req}`);
      this.socket.write(req);

      if (!responseExpected) {
        return "";
      }
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          logger.log(`[GDB] TIMEOUT: ${req}`);
          delete this.responseCallback;
          reject(new Error("Request timeout"));
        }, TIMEOUT);

        this.responseCallback = (message: string) => {
          logger.log(`[GDB] <-- ${message}`);
          if (message.startsWith("E")) {
            this.responseCallback = undefined;
            clearTimeout(timeout);
            reject(new GdbError(message));
          } else if (
            !message.match(/^O[0-9a-f]/i) && // Ignore output
            (!expectedResponse || message.startsWith(expectedResponse))
          ) {
            this.responseCallback = undefined;
            clearTimeout(timeout);
            resolve(message);
          } else {
            logger.log(`[GDB] ignored`);
          }
        };
      });
    });
  }

  private handleData(data: Buffer) {
    const messages = [...data.toString().matchAll(/\$([^#]*)#[\da-f]{2}/g)].map(
      (m) => m[1]
    );
    for (const message of messages) {
      if (this.responseCallback) {
        this.responseCallback(message);
      } else {
        switch (message[0]) {
          case "S":
          case "T":
            if (!message.startsWith("Te") || !message.includes("tframes")) {
              logger.log(`[GDB] STOP: ${message}`);
            }
            this.haltStatus = this.parseHaltStatus(message);
            this.sendEvent("stop", this.haltStatus);
            break;
          case "W":
            logger.log(`[GDB] END`);
            this.sendEvent("end");
            break;
          case "O":
            logger.log(`[GDB] OUTPUT: ${message}`);
            this.sendEvent("output", hexStringToASCII(message.substring(1), 2));
            break;
          default:
            logger.log(`[GDB] UNKNOWN: ${message}`);
        }
      }
    }
  }

  private parseHaltStatus(message: string): HaltEvent {
    // Special case to treat S05 as exception:
    // Emulator currently returns this code for non-specified exceptions, but normally 05 is treated as a breakpoint.
    // We can differentiate because actual breakpoints use T05swbreak.
    if (message === "S05") {
      return {
        signal: HaltSignal.SEGV,
        label: "Exception",
      };
    }
    const code = parseInt(message.substring(1, 3), 16) as HaltSignal;
    const details = signalLabels[code] || "Exception";
    const threadMatch = message.match(/thread:(\d+)/);
    const threadId = threadMatch ? parseInt(threadMatch[1]) : undefined;
    return { signal: code, label: details, threadId };
  }
}

// Errors:

const errorMessages = {
  E01: "General error during processing",
  E02: "Error during the packet parse",
  E03: "Unsupported / unknown command",
  E04: "Unknown register",
  E05: "Invalid Frame Id",
  E06: "Invalid memory location",
  E07: "Address not safe for a set memory command",
  E08: "Unknown breakpoint",
  E09: "The maximum of breakpoints have been reached",
  E0F: "Error during the packet parse for command send memory",
  E10: "Unknown register",
  E11: "Invalid Frame Id",
  E12: "Invalid memory location",
  E20: "Error during the packet parse for command set memory",
  E21: "Missing end packet for a set memory message",
  E22: "Address not safe for a set memory command",
  E25: "Error during the packet parse for command set register",
  E26: "Error during set register - unsupported register name",
  E30: "Error during the packet parse for command get register",
  E31: "Error during the vCont packet parse",
  E40: "Unable to load segments",
  E41: "Thread command parse error",
};

type ErrorType = keyof typeof errorMessages;

export class GdbError extends Error {
  public errorType: ErrorType;
  constructor(errorType: string) {
    super();
    this.errorType = errorType.toUpperCase() as ErrorType;
    this.name = "GdbError";
    const msg = errorMessages[this.errorType as keyof typeof errorMessages];
    this.message = msg || "Error code received: '" + this.errorType + "'";
  }
}

// Utils:

function calculateChecksum(text: string): string {
  let cs = 0;
  const buffer = Buffer.alloc(text.length, text);
  for (let i = 0; i < buffer.length; ++i) {
    cs += buffer[i];
  }
  return (cs % 256).toString(16).padStart(2, "0");
}

const hex = (n: number) => n.toString(16);

function stringToHex(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; ++i) {
    result += str.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return result;
}
