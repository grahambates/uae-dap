import { Socket } from "net";
import { EventEmitter } from "events";
import { logger } from "@vscode/debugadapter";
import { Mutex } from "./utils/mutex";
import { REGISTER_PC_INDEX } from "./registers";

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

export enum BreakpointCode {
  SOFTWARE = 0,
  HARDWARE = 1,
  WRITE = 2,
  READ = 3,
  ACCESS = 4,
}

type Events = {
  stop: (haltStatus: HaltStatus) => void;
  end: () => void;
  packet: (packet: Packet) => void;
};

export const DEFAULT_FRAME_INDEX = -1;
const TIMEOUT = 5000;

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

export class GdbClient {
  private socket: Socket;
  private mutex = new Mutex(100, 60000);
  private eventEmitter: EventEmitter;

  constructor(socket?: Socket) {
    this.eventEmitter = new EventEmitter();
    this.socket = socket || new Socket();
    this.on("packet", this.handlePacket.bind(this));
    this.socket.on("data", (data) => {
      for (const packet of parsePackets(data)) {
        if (packet.type !== PacketType.PLUS) {
          this.sendEvent("packet", packet);
        }
      }
    });
  }

  public async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cb = async () => {
        try {
          logger.log("Connected: initializing");
          await this.request(
            "qSupported:QStartNoAckMode+;multiprocess+;vContSupported+;QNonStop+"
          );
          await this.request("QStartNoAckMode");
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
    const res = await this.request("qOffsets", PacketType.UNKNOWN);
    return res.split(";").map((a) => parseInt(a, 16));
  }

  // Breakpoints:

  public async setBreakpoint(
    address: number,
    type = BreakpointCode.SOFTWARE,
    size?: number
  ): Promise<void> {
    let message = `Z${type},${formatNumber(address)}`;
    if (size !== undefined) {
      message += `,${formatNumber(size)}`;
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
    type = BreakpointCode.SOFTWARE,
    size?: number
  ): Promise<void> {
    let message = `z${type},${formatNumber(address)}`;
    if (size !== undefined) {
      message += `,${formatNumber(size)}`;
    }
    await this.request(message, PacketType.OK);
  }

  // Navigation:

  public async pause(threadId: number): Promise<void> {
    await this.request("vCont;t:" + threadId, PacketType.STOP);
  }

  public async continueExecution(threadId: number): Promise<void> {
    await this.request("vCont;c:" + threadId, null, false);
  }

  public async stepIn(threadId: number): Promise<void> {
    await this.request("vCont;s:" + threadId, PacketType.STOP);
  }

  public async stepToRange(
    threadId: number,
    startAddress: number,
    endAddress: number
  ): Promise<void> {
    const message =
      "vCont;r" +
      formatNumber(startAddress) +
      "," +
      formatNumber(endAddress) +
      ":" +
      threadId;
    await this.request(message, PacketType.STOP);
  }

  public async getHaltStatus(): Promise<HaltStatus | null> {
    const response = await this.request("?", PacketType.STOP);
    return response.indexOf("OK") < 0 ? this.parseHaltStatus(response) : null;
  }

  public async getVStopped(): Promise<HaltStatus | null> {
    const response = await this.request("vStopped", null);
    return response.indexOf("OK") < 0 ? this.parseHaltStatus(response) : null;
  }

  // Memory:

  public async readMemory(address: number, length: number): Promise<string> {
    const hex = await this.request(
      "m" + formatNumber(address) + "," + formatNumber(length),
      PacketType.UNKNOWN
    );
    return hex;
  }

  public async writeMemory(address: number, dataToSend: string): Promise<void> {
    const size = Math.ceil(dataToSend.length / 2);
    await this.request(
      "M" + formatNumber(address) + "," + size + ":" + dataToSend,
      PacketType.OK
    );
  }

  // Registers:

  public async getRegisters(threadId?: number | null): Promise<number[]> {
    const command = threadId ? "Hg" + threadId : "g";
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

  // Stack Frames:

  public async getFramesCount(): Promise<number> {
    const data = await this.request("qTStatus", PacketType.QTSTATUS);
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
      await this.request("QTFrame:ffffffff", PacketType.OK);
      return DEFAULT_FRAME_INDEX;
    }
    const message = "QTFrame:" + formatNumber(frameIndex);
    const data = await this.request(message, PacketType.FRAME);

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
      logger.log(`[GDB] ${requestText} -->`);
      this.socket.write(formatString(requestText));

      if (responseExpected) {
        const packet = await new Promise<Packet>((resolve, reject) => {
          const timeout = setTimeout(() => {
            logger.log(`[GDB] ${requestText} <-- TIMEOUT`);
            this.off("packet", testPacket);
            reject(new Error("Request timeout"));
          }, TIMEOUT);

          const testPacket = (testedPacket: Packet) => {
            if (!responseType || responseType === testedPacket.type) {
              `[GDB] ${requestText} <-- ${testedPacket.message}`;
              clearTimeout(timeout);
              this.off("packet", testPacket);
              return resolve(testedPacket);
            }
            if (packet.type === PacketType.ERROR) {
              clearTimeout(timeout);
              this.off("packet", testPacket);
              logger.log(
                `[GDB] ${requestText} <-- ERROR ${testedPacket.message}`
              );
              return reject(new GdbError(response));
            }
            `[GDB] ignoring packet ${testedPacket.message}`;
          };
          this.on("packet", testPacket);
        });

        const response = packet.message;

        return response;
      }
    } finally {
      unlock();
    }
    return "";
  }

  private handlePacket(packet: Packet) {
    logger.log(`[GDB] <-- ${packet.message}`);
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
      default:
        break;
    }
  }

  private parseHaltStatus(message: string): HaltStatus {
    // ‘TAAn1:r1;n2:r2;…’
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

  public async withFrame<T>(
    requestedFrame: number | undefined,
    cb: (returnedFrame: number) => Promise<T>
  ): Promise<T> {
    const unlock = await this.mutex.capture("frame");
    try {
      const returnedFrame = await this.selectFrame(
        requestedFrame || DEFAULT_FRAME_INDEX
      );
      return cb(returnedFrame);
    } finally {
      unlock();
    }
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
