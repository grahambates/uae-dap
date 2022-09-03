import { Socket } from "net";
import { EventEmitter } from "events";
import { logger } from "@vscode/debugadapter";
import { Mutex } from "./utils/mutex";

export interface Thread {
  processId: number;
  threadId: ThreadId;
  running: boolean;
}

/** System Threads numbers (DMA) */
export enum ThreadId {
  CPU = 1, // default cpu execution
  COP = 2, // COPPER interrupt
  AUD0 = 3, // AUDIO 0 interrupt
  AUD1 = 4, // AUDIO 1 interrupt
  AUD2 = 5, // AUDIO 2 interrupt
  AUD3 = 6, // AUDIO 3 interrupt
  DSK = 7, // DISK interrupt
  SPR = 8, // SPRITE interrupt
  BLT = 9, // BLITTER interrupt
  BPL = 10, // BIT-PLANE interrupt
}

export interface Segment {
  address: number;
  name: string;
}

export interface HaltStatus {
  code: HaltSignal;
  details: string;
  registers: Map<number, number>;
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

interface Packet {
  type: PacketType;
  message: string;
  isNotification?: boolean;
}

export enum PacketType {
  ERROR,
  REGISTER,
  MEMORY,
  SEGMENT,
  END,
  STOP,
  UNKNOWN,
  OK,
  PLUS,
  FRAME,
  MINUS,
  OUTPUT,
  QTSTATUS,
}

type Events = {
  connected: () => void;
  stop: (haltStatus: HaltStatus) => void;
  segments: (segments: Segment[]) => void;
  end: () => void;
  error: (err: Error) => void;
  packet: (packet: Packet) => void;
};

const REGISTER_PC_INDEX = 17;
const DEFAULT_FRAME_INDEX = -1;
const DEFAULT_PROCESS_ID = 1;

// Labels:

const signalLabels: Record<HaltSignal, string> = {
  [HaltSignal.INT]: "Interrupt",
  [HaltSignal.ILL]: "Illegal instruction",
  [HaltSignal.TRAP]: "Trace/breakpoint trap",
  [HaltSignal.EMT]: "Emulation trap",
  [HaltSignal.FPE]: "Arithmetic exception",
  [HaltSignal.BUS]: "Bus error",
  [HaltSignal.SEGV]: "Segmentation fault",
};

const threadLabels: Record<ThreadId, string> = {
  [ThreadId.AUD0]: "audio 0",
  [ThreadId.AUD1]: "audio 1",
  [ThreadId.AUD2]: "audio 2",
  [ThreadId.AUD3]: "audio 3",
  [ThreadId.BLT]: "blitter",
  [ThreadId.BPL]: "bit-plane",
  [ThreadId.COP]: "copper",
  [ThreadId.CPU]: "cpu",
  [ThreadId.DSK]: "disk",
  [ThreadId.SPR]: "sprite",
};

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

/**
 * Class to contact the fs-UAE GDB server.
 */
export class GdbClient {
  private socket: Socket;
  private mutex = new Mutex(100, 60000);

  // Client capabilities:
  private supportVCont = false;
  private supportMultiprocess = false;

  private eventEmitter: EventEmitter;

  constructor(socket?: Socket) {
    this.eventEmitter = new EventEmitter();
    this.socket = socket || new Socket();
    this.on("packet", this.handlePacket.bind(this));
  }

  public async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.on("data", (data) => {
        for (const packet of parsePackets(data)) {
          if (packet.type !== PacketType.PLUS) {
            this.sendEvent("packet", packet);
          }
        }
      });

      this.socket.on("error", (err) => {
        // Don't send events for connection error so we can retry
        if (!err.message.includes("ECONNREFUSED")) {
          this.sendEvent("error", err);
        }
        reject(err);
      });

      this.socket.once("connect", async () => {
        try {
          const data = await this.request(
            "qSupported:QStartNoAckMode+;multiprocess+;vContSupported+;QNonStop+",
            PacketType.UNKNOWN
          );
          const returnedData = data;
          if (returnedData.indexOf("multiprocess+") >= 0) {
            this.supportMultiprocess = true;
          }
          if (returnedData.indexOf("vContSupported+") >= 0) {
            this.supportVCont = true;
          }
          if (returnedData.indexOf("QStartNoAckMode+") >= 0) {
            await this.request("QStartNoAckMode", PacketType.OK);
          } else {
            throw new Error("QStartNoAckMode not active in remote debug");
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.socket.connect(port, host);
    });
  }

  public destroy(): void {
    this.socket.destroy();
  }

  // Segments:

  public async getSegments(): Promise<Segment[]> {
    const segmentReply = await this.request("qOffsets", PacketType.UNKNOWN);
    // expected return message : TextSeg=00c03350;DataSeg=00c03350
    return segmentReply.split(";").map((seg, i) => {
      const segElms = seg.split("=");
      let name: string;
      let address: string;
      if (segElms.length > 1) {
        name = segElms[0];
        address = segElms[1];
      } else {
        name = `Segment${i + 1}`;
        address = segElms[0];
      }
      return { name, address: parseInt(address, 16) };
    });
  }

  // Breakpoints:

  public async setBreakpoint(
    address: number,
    type = 0,
    size?: number
  ): Promise<void> {
    let message = `Z${type},${address}`;
    if (size !== undefined) {
      message += `,${size}`;
    }
    await this.request(message, PacketType.OK);
  }

  public async setExceptionBreakpoint(exceptionMask: number): Promise<void> {
    const expMskHex = formatNumber(exceptionMask);
    const expMskHexSz = formatNumber(expMskHex.length);
    const message = "Z1,0,0;X" + expMskHexSz + "," + expMskHex;
    await this.request(message, PacketType.OK);
  }

  public async removeBreakpoint(
    address: number,
    type = 0,
    size?: number
  ): Promise<void> {
    let message = `z${type},${formatNumber(address)}`;
    if (size !== undefined) {
      message += `,${formatNumber(size)}`;
    }
    await this.request(message, PacketType.OK);
  }

  // Navigation:

  public async pause(thread: Thread): Promise<void> {
    const message = this.supportVCont
      ? "vCont;t:" + this.formatThread(thread)
      : "vCtrlC";
    thread.running = false;
    await this.request(message, PacketType.STOP);
  }

  public async continueExecution(thread: Thread): Promise<void> {
    const message = this.supportVCont
      ? "vCont;c:" + this.formatThread(thread)
      : "c";
    thread.running = true;
    await this.request(message, null, false);
  }

  public async stepIn(thread: Thread): Promise<void> {
    const message = this.supportVCont
      ? "vCont;s:" + this.formatThread(thread)
      : "s";
    thread.running = false;
    await this.request(message, PacketType.STOP);
  }

  public async stepToRange(
    thread: Thread,
    startAddress: number,
    endAddress: number
  ): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      message =
        "vCont;r" +
        formatNumber(startAddress) +
        "," +
        formatNumber(endAddress) +
        ":" +
        this.formatThread(thread);
    } else {
      // Not a real GDB command...
      message = "n";
    }
    thread.running = false;
    await this.request(message, PacketType.STOP);
  }

  public async getHaltStatus(): Promise<HaltStatus[]> {
    const returnedHaltStatus: HaltStatus[] = [];
    const response = await this.request("?", PacketType.STOP);
    if (response.indexOf("OK") < 0) {
      returnedHaltStatus.push(this.parseHaltStatus(response));
    }
    return returnedHaltStatus;
  }

  // Memory:

  public async getMemory(address: number, length: number): Promise<string> {
    return this.request(
      "m" + formatNumber(address) + "," + formatNumber(length),
      PacketType.UNKNOWN
    );
  }

  public async setMemory(address: number, dataToSend: string): Promise<void> {
    const size = Math.ceil(dataToSend.length / 2);
    await this.request(
      "M" + formatNumber(address) + "," + size + ":" + dataToSend,
      PacketType.OK
    );
  }

  // Registers:

  public async getRegisters(thread?: Thread | null): Promise<number[]> {
    const command = thread ? "Hg" + thread.threadId : "g";
    const message = await this.request(command, PacketType.UNKNOWN);
    const registers: number[] = [];

    const regCount = Math.floor(message.length / 8);
    for (let i = 0; i < regCount; i++) {
      const value = parseInt(message.substring(i * 8, (i + 1) * 8), 16);
      registers.push(value);
    }
    return registers;
  }

  public async getRegister(regIdx: number): Promise<number> {
    const data = await this.request(
      "p" + formatNumber(regIdx),
      PacketType.UNKNOWN
    );
    return parseInt(data, 16);
  }

  public async setRegister(regIdx: number, value: string): Promise<string> {
    if (!value.match(/[a-z\d]{1,8}/i)) {
      throw new Error("The value must be a hex string with at most 8 digits");
    }
    const message = "P" + regIdx.toString(16) + "=" + value;
    const response = await this.request(message, null);
    if (response && response.indexOf("OK") >= 0) {
      return value;
    } else {
      throw new Error("Error setting the register value");
    }
  }

  // Threads:

  public async getThreads(): Promise<Thread[]> {
    const unlock = await this.mutex.capture("getThreads");
    try {
      let data = await this.request("qfThreadInfo", PacketType.UNKNOWN);
      if (data.startsWith("m")) {
        data = data.substring(1).trim();
      }
      if (data.endsWith("l")) {
        data = data.substring(0, data.length - 1);
      }
      if (data.endsWith(",")) {
        data = data.substring(0, data.length - 1);
      }
      return data.split(",").map((elm) => {
        // Thread id has the form : "p<process id in hex>.<thread id in hex>"
        const pth = elm.split(".");
        let processId = DEFAULT_PROCESS_ID;
        let threadId = 0;
        if (pth.length > 1) {
          processId = parseInt(pth[0].substring(1), 16);
          threadId = parseInt(pth[1], 16);
        } else {
          threadId = parseInt(pth[0], 16);
        }
        return { processId, threadId, running: true };
      });
    } finally {
      unlock();
    }
  }

  // Stack Frames:

  public async getFramesCount(thread: Thread): Promise<number> {
    if (thread.threadId === ThreadId.CPU) {
      const message = "qTStatus";
      const data = await this.request(message, PacketType.QTSTATUS);
      const frameCountPosition = data.indexOf("tframes");
      if (frameCountPosition > 0) {
        let endFrameCountPosition = data.indexOf(";", frameCountPosition);
        if (endFrameCountPosition <= 0) {
          endFrameCountPosition = data.length;
        }
        const v = data.substring(frameCountPosition + 8, endFrameCountPosition);
        return parseInt(v, 16);
      }
    }
    return 1;
  }

  public async selectFrame(
    num: number | null,
    pc: number | null
  ): Promise<number> {
    try {
      let message = "QTFrame:";
      if (num !== null) {
        if (num < 0) {
          message += "ffffffff";
          await this.request(message, PacketType.OK);
          return DEFAULT_FRAME_INDEX;
        } else {
          message += formatNumber(num);
        }
      } else if (pc !== null) {
        message += "pc:" + formatNumber(pc);
      } else {
        throw new Error("No arguments to select a frame");
      }
      const data = await this.request(message, PacketType.FRAME);
      if (data === "F-1") {
        // No frame found
        return DEFAULT_FRAME_INDEX;
      } else {
        let v = data.substring(1);
        const tPos = v.indexOf("T");
        if (tPos >= 0) {
          v = v.substring(0, tPos);
        }
        return parseInt(v, 16);
      }
    } catch (err) {
      return DEFAULT_FRAME_INDEX;
    }
  }

  // Commands:

  public async monitor(command: string): Promise<string> {
    const response = await this.request("qRcmd," + stringToHex(command), null);
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

  // Internals:

  private sendEvent<U extends keyof Events>(
    event: U,
    ...args: Parameters<Events[U]>
  ): void {
    setImmediate(() => {
      this.eventEmitter.emit(event, ...args);
    });
  }

  private async request(
    requestText: string,
    responseType: PacketType | null = null,
    responseExpected = true
  ): Promise<string> {
    if (!this.socket.writable) {
      throw new Error("Socket can't be written");
    }

    const unlock = await this.mutex.capture("request");
    try {
      const expectedTypeName = responseType ? PacketType[responseType] : "null";
      logger.log(`[GDB] --> ${requestText} / ${expectedTypeName}`);

      this.socket.write(formatString(requestText));

      if (responseExpected) {
        const packet = await new Promise<Packet>((res) => {
          const testPacket = (testedPacket: Packet) => {
            if (
              responseType === null ||
              testedPacket.type === PacketType.ERROR ||
              responseType === testedPacket.type
            ) {
              this.off("packet", testPacket);
              res(testedPacket);
            }
          };
          this.on("packet", testPacket);
        });

        if (!packet) {
          throw new Error("No response from the emulator");
        }

        const response = packet.message;
        logger.log(`[GDB] <-- req: ${requestText} res: ${response}`);

        if (packet.type === PacketType.ERROR) {
          const error = new GdbError(response);
          this.sendEvent("error", error);
          throw error;
        }

        return response;
      }
    } finally {
      unlock();
    }
    return "";
  }

  private handlePacket = (packet: Packet) => {
    switch (packet.type) {
      case PacketType.OUTPUT: {
        const msg = hexToString(packet.message.substring(1));
        logger.log(`[GDB] server output : ${msg}`);
        break;
      }
      case PacketType.STOP:
        this.sendEvent("stop", this.parseHaltStatus(packet.message));
        break;
      case PacketType.END:
        this.sendEvent("end");
        break;
      case PacketType.MINUS:
        this.sendEvent("error", new Error("Unsupported packet : '-'"));
        break;
      default:
        break;
    }
  };

  private formatThread(thread: Thread): string {
    return this.supportMultiprocess
      ? "p" + thread.processId.toString(16) + "." + thread.threadId.toString(16)
      : thread.threadId.toString(16);
  }

  /**
   * Parses the halt status
   * ‘TAAn1:r1;n2:r2;…’
   */
  private parseHaltStatus(message: string): HaltStatus {
    const code = parseInt(message.substring(1, 3), 16) as HaltSignal;
    let parameters: string | null = null;
    if (message.length > 3) {
      parameters = message.substring(3);
    }
    const details = signalLabels[code] || "Other exception";
    let posString = "";
    const registers = new Map<number, number>();
    let threadId: number | undefined;
    if (parameters) {
      const registers = new Map<number, number>();
      let threadId;
      const elms = parameters.trim().split(";");
      for (const elm of elms) {
        const kv = elm.split(":");
        if (kv.length > 1) {
          if ("thread" === kv[0]) {
            threadId = parseInt(kv[1]);
          } else if (kv.length > 0) {
            registers.set(parseInt(kv[0], 16), parseInt(kv[1], 16));
          }
        }
      }
      const pc = registers.get(REGISTER_PC_INDEX);
      if (pc) {
        posString = " in $" + formatNumber(pc);
      }
      if (threadId) {
        posString += " thread: " + threadId;
      }
    }
    return {
      code,
      details: "Exception " + code + posString + ": " + details,
      threadId,
      registers,
    };
  }
}

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

export function threadDisplayName(thread: Thread): string {
  return threadLabels[thread.threadId];
}

// Utils:

function calculateChecksum(text: string): string {
  let cs = 0;
  const buffer = Buffer.alloc(text.length, text);
  for (let i = 0; i < buffer.length; ++i) {
    cs += buffer[i];
  }
  cs = cs % 256;
  const s = formatNumber(cs);
  if (s.length < 2) {
    return "0" + s;
  } else {
    return s;
  }
}

function formatString(text: string): Buffer {
  const data = Buffer.alloc(text.length + 5);
  let offset = 0;
  data.write("$", offset++);
  data.write(text, offset);
  offset += text.length;
  data.write("#", offset++);
  data.write(calculateChecksum(text), offset);
  offset += 2;
  data.writeInt8(0, offset);
  return data;
}

function formatNumber(n: number): string {
  if (n === 0) {
    return "0";
  }
  return n.toString(16);
}

function hexToString(hex: string): string {
  // split input into groups of two
  const bytes = hex.match(/[\s\S]{2}/g) || [];
  // build a URL-encoded representation of the string
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    output += "%" + ("0" + bytes[i]).slice(-2);
  }
  return decodeURIComponent(output);
}

function stringToHex(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; ++i) {
    result += ("00" + str.charCodeAt(i).toString(16)).slice(-2);
  }
  return result;
}

function parsePackets(data: Buffer): Packet[] {
  if (!data) {
    return [];
  }
  const parsedData: Packet[] = [];
  let s = data.toString();
  if (s.startsWith("+")) {
    parsedData.push({
      type: PacketType.PLUS,
      message: "+",
    });
    if (s.length > 1) {
      s = s.substring(1);
    }
  }
  if (s.length > 0) {
    const messageRegexp = /\$([^$]*)#[\da-f]{2}/gi;
    if (s.startsWith("+")) {
      s = s.substring(1);
    }
    let match = messageRegexp.exec(s);
    while (match) {
      let message = extractPacketMessage(match[1]);
      let isNotification = false;
      if (message.startsWith("%Stop")) {
        isNotification = true;
        message = message.replace("%Stop:", "");
      }
      parsedData.push({
        type: extractPacketType(message),
        message,
        isNotification,
      });
      match = messageRegexp.exec(s);
    }
  }
  return parsedData;
}

function extractPacketMessage(message: string): string {
  if (message.startsWith("$")) {
    const pos = message.indexOf("#");
    if (pos > 0) {
      return message.substring(1, pos);
    }
  }
  return message;
}

function extractPacketType(message: string): PacketType {
  if (message.startsWith("OK")) {
    return PacketType.OK;
  } else if (message.startsWith("+")) {
    return PacketType.PLUS;
  } else if (message.startsWith("AS")) {
    return PacketType.SEGMENT;
  } else if (message.startsWith("E")) {
    return PacketType.ERROR;
  } else if (
    message.startsWith("S") ||
    (message.startsWith("T") && !message.startsWith("Te"))
  ) {
    if (message.includes("tframes")) {
      return PacketType.QTSTATUS;
    }
    return PacketType.STOP;
  } else if (message.startsWith("W")) {
    return PacketType.END;
  } else if (message.startsWith("F")) {
    return PacketType.FRAME;
  } else if (message === "-") {
    return PacketType.MINUS;
  } else if (message.startsWith("O")) {
    return PacketType.OUTPUT;
  }
  return PacketType.UNKNOWN;
}
