import { Socket } from "net";
import { EventEmitter } from "events";
import { logger } from "@vscode/debugadapter";
import { Mutex } from "async-mutex";
import { hexStringToASCII } from "./utils/strings";
import { REGISTER_SR_INDEX } from "./registers";

//const logger = console;

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

const resp = {
  OK: /^OK$/,
  HEX: /^[0-9a-f]/,
  STOP: /^[ST]/,
  ANY: /./,
};

export class GdbClient {
  private socket: Socket;
  private requestMutex = new Mutex();
  private frameMutex = new Mutex();
  private eventEmitter: EventEmitter;
  private responseCallback?: (message: string) => void;
  private haltStatus: HaltEvent | undefined;
  private verboseResumeSupported = false; // this only available in non-stop mode?
  private nonstopSupported = false;

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
          //          this.socket.write("+"); // hello to stub
          //          await this.request("QStartNoAckMode"); // mame doesn't support no ack mode
          const supported = await this.request(
            "qSupported:vContSupported+",
            resp.ANY
          );
          this.nonstopSupported = supported.includes("QNonStop+");
          if (supported.includes("qXfer:features:read+")) {
            // fetch target xml description - mame checks if we did this,
            // and replies E01 in certain cases if not
            await this.request(
              "qXfer:features:read:target.xml:0,1000",
              resp.ANY
            );
            // mame returns the sr as only 16 bits, so we really should parse the xml to be sure
          }

          if (this.nonstopSupported) {
            await this.request("QNonStop:1"); // enable non-stop mode
          }
          this.verboseResumeSupported = (
            await this.request("vCont?", /vCont.*|/)
          ).startsWith("vCont");

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
    const res = await this.request("qOffsets", resp.HEX);
    return res.split(";").map((a) => parseInt(a, 16));
  }

  // Breakpoints:

  public async setBreakpoint(
    address: number,
    type = BreakpointCode.SOFTWARE,
    size?: number
  ): Promise<void> {
    let message = `Z${type},${hex(address)},0`;
    if (size !== undefined) {
      message += `,${hex(size)}`;
    }
    await this.request(message);
  }

  /* mame doesn't support breakpoint cond_list - it also treats sw/hw bp's the same,
   and ignores the 'kind' parameter (it must be supplied though) */
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
    let message = `z${type},${hex(address)},0`;
    if (size !== undefined) {
      message += `,${hex(size)}`;
    }
    await this.request(message);
  }

  // Navigation:
  private async stopAndContinueNoVerboseResume(
    op: string,
    res?: RegExp,
    threadId?: number
  ): Promise<void> {
    if (threadId == undefined) threadId = -1;
    await this.request("Hc" + threadId, resp.OK);
    res ? await this.request(op, res) : await this.requestNoRes(op);
  }

  private async stopAndContinueVerboseResume(
    op: string,
    res?: RegExp,
    threadId?: number
  ): Promise<void> {
    if (threadId == undefined) threadId = -1;
    op = "vCont;" + op + ":" + threadId;
    res ? await this.request(op, res) : await this.requestNoRes(op);
  }

  public async pause(threadId: number): Promise<void> {
    this.verboseResumeSupported
      ? await this.stopAndContinueVerboseResume("t", resp.STOP, threadId)
      : this.nonstopSupported
      ? await this.stopAndContinueNoVerboseResume("vCtrlC", resp.OK, threadId)
      : await this.requestRawHalt(new Uint8Array([0x3]));
  }

  public async continueExecution(threadId?: number): Promise<void> {
    this.verboseResumeSupported
      ? await this.stopAndContinueVerboseResume("c", undefined, threadId)
      : await this.stopAndContinueNoVerboseResume("c", undefined, threadId);
  }

  public async stepIn(threadId: number): Promise<void> {
    this.verboseResumeSupported
      ? await this.stopAndContinueVerboseResume("s", resp.STOP, threadId)
      : await this.stopAndContinueNoVerboseResume("s", resp.STOP, threadId);
  }

  public async stepToRange(
    threadId: number,
    startAddress: number,
    endAddress: number
  ): Promise<void> {
    /* From the gdb docs: (A stop reply may be sent at any point even if the PC is still within the stepping range; 
    for example, it is valid to implement this packet in a degenerate way as a single instruction step operation.) 
    So that's what I did because I can't see other options without vCont support */
    this.verboseResumeSupported
      ? await this.request(
          "vCont;r" +
            hex(startAddress) +
            "," +
            hex(endAddress) +
            ":" +
            threadId,
          resp.STOP
        )
      : await this.stepIn(threadId);
  }

  public async getHaltStatus(): Promise<HaltEvent | null> {
    if (this.haltStatus) {
      return this.haltStatus;
    }
    const response = await this.request("?", /^(OK|S|T)/);
    return response.indexOf("OK") < 0 ? this.parseHaltStatus(response) : null;
  }

  // Memory:

  public async readMemory(address: number, length: number): Promise<string> {
    return this.request("m" + hex(address) + "," + hex(length), resp.HEX);
  }

  public async writeMemory(address: number, dataToSend: string): Promise<void> {
    const size = Math.ceil(dataToSend.length / 2);
    await this.request("M" + hex(address) + "," + size + ":" + dataToSend);
  }

  // Registers:

  public async getRegisters(threadId?: number | null): Promise<number[]> {
    const message = await this.request(
      threadId ? "Hg" + threadId : "g",
      resp.HEX
    );
    const registers: number[] = [];

    // count and len should be parsed from target.xml (fetched in connect)
    const regCount = 18; //Math.floor(message.length / 8);
    let pos = 0;
    for (let i = 0; i < regCount; i++) {
      const len = i == REGISTER_SR_INDEX ? 4 : 8;
      const value = parseInt(message.substring(pos, pos + len), 16);
      pos += len;
      registers.push(value);
    }
    return registers;
  }

  public async getRegister(regIdx: number): Promise<number> {
    const data = await this.request("p" + hex(regIdx), resp.HEX);
    return parseInt(data, 16);
  }

  public async setRegister(regIdx: number, value: number): Promise<void> {
    await this.request("P" + regIdx.toString(16) + "=" + value.toString(16));
  }

  // Stack Frames:

  // Mame doesn't support qTStatus or QTFrame, so what to do? trying to return defaults!

  public async getFramesCount(): Promise<number> {
    return 1;
  }

  public async selectFrame(frameIndex: number): Promise<number> {
    return DEFAULT_FRAME_INDEX;
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
    const response = await this.request(
      "qRcmd," + stringToHex(command),
      resp.ANY
    );
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
    expectedResponse = resp.OK
  ): Promise<string> {
    return this.requestMutex.runExclusive(async () => {
      const req = `$${text}#${calculateChecksum(text)}`;
      logger.log(`[GDB] --> ${req}`);
      this.socket.write(req);

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
          } else if (message.match(expectedResponse)) {
            this.responseCallback = undefined;
            clearTimeout(timeout);
            resolve(message);
          } else {
            // an "empty" response (i.e. nothing between '$' and '#') means the stub doesn't support the command.
            // unfortunately, an ill-formed response (which winuae seems to send) also emerges here as an "empty" response
            logger.log(`[GDB] ignored`);
          }
        };
      });
    });
  }

  private async requestNoRes(text: string): Promise<void> {
    return this.requestMutex.runExclusive(async () => {
      const req = `$${text}#${calculateChecksum(text)}`;
      logger.log(`[GDB] --> ${req}`);
      this.socket.write(req);
    });
  }

  private async requestRawHalt(data: Uint8Array): Promise<void> {
    return this.requestMutex.runExclusive(async () => {
      const req = data.join(",");
      logger.log(`[GDB] --> ${req}`);
      this.socket.write(data);

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          logger.log(`[GDB] TIMEOUT: ${req}`);
          delete this.responseCallback;
          reject(new Error("Request timeout"));
        }, TIMEOUT);

        this.responseCallback = (message: string) => {
          logger.log(`[GDB] <-- ${message}`);
          this.haltStatus = this.parseHaltStatus(message);
          //          this.sendEvent("stop", this.haltStatus);
          this.responseCallback = undefined;
          clearTimeout(timeout);
          resolve();
        };
      });
    });
  }

  private handleData(data: Buffer) {
    this.socket.write("+"); // ack
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
            logger.log(`[GDB] STOP: ${message}`);
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
