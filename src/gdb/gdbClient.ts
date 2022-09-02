import { Socket } from "net";
import { EventEmitter } from "events";
import { Mutex } from "../utils/mutex";
import { Thread, ThreadState } from "./threads";
import { GdbReceivedDataManager } from "./events";
import { Packet, PacketType } from "./packets";
import { hexUTF8StringToUTF8, asciiToHex } from "../utils/strings";
import { logger } from "@vscode/debugadapter";

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

export interface Segment {
  id: number;
  address: number;
  size: number;
}

type Events = {
  connected: () => void;
  stop: (haltStatus: HaltStatus) => void;
  segments: (segments: Segment[]) => void;
  end: () => void;
  error: (err: Error) => void;
};

const REGISTER_PC_INDEX = 17;
const DEFAULT_FRAME_INDEX = -1;

const signalDescriptions: Record<HaltSignal, string> = {
  [HaltSignal.INT]: "Interrupt",
  [HaltSignal.ILL]: "Illegal instruction",
  [HaltSignal.TRAP]: "Trace/breakpoint trap",
  [HaltSignal.EMT]: "Emulation trap",
  [HaltSignal.FPE]: "Arithmetic exception",
  [HaltSignal.BUS]: "Bus error",
  [HaltSignal.SEGV]: "Segmentation fault",
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

/**
 * Class to contact the fs-UAE GDB server.
 */
export class GdbClient {
  /** Socket to connect */
  private socket: Socket;
  /** Mutex to just have one call to gdb */
  private mutex = new Mutex(100, 60000);
  /** vCont commands are supported */
  private supportVCont = false;
  /** Created threads */
  private threads: Map<number, Thread>;
  /** Created threads indexed by native ids */
  private threadsNative: Map<string, Thread>;
  /** Manager for the received socket data */
  private receivedDataManager: GdbReceivedDataManager;
  /** If true the proxy is connected */
  private connected = false;

  private eventEmitter: EventEmitter;

  /**
   * Constructor
   * The socket is needed only for unit test mocking.
   * @param socket Socket instance created to contact the server (for unit tests)
   */
  constructor(socket?: Socket) {
    this.eventEmitter = new EventEmitter();
    if (socket) {
      this.socket = socket;
    } else {
      this.socket = new Socket();
    }
    this.receivedDataManager = new GdbReceivedDataManager(
      this.defaultOnDataHandler
    );
    this.threads = new Map<number, Thread>();
    this.threadsNative = new Map<string, Thread>();
  }

  // Public API:

  /**
   * Function to connect to the server
   * @param host Server host
   * @param port Server socket port
   */
  public async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(port, host);
      this.socket.once("connect", async () => {
        try {
          const data = await this.request(
            "qSupported:QStartNoAckMode+;multiprocess+;vContSupported+;QNonStop+",
            PacketType.UNKNOWN
          );
          const returnedData = data;
          if (returnedData.indexOf("multiprocess+") >= 0) {
            Thread.setSupportMultiprocess(true);
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
      this.socket.on("error", (err) => {
        // Don't send events for connection error so we can retry
        if (!err.message.includes("ECONNREFUSED")) {
          if (this.sendPacketStringLock) {
            this.sendPacketStringLock();
            this.sendPacketStringLock = undefined;
          }
          this.sendEvent("error", err);
        }
        reject(err);
      });
      this.socket.on("data", (data) => {
        this.onData(data);
      });
    });
  }

  /**
   * Set the mutex timeout
   * @param timeout Mutex timeout
   */
  public setMutexTimeout(timeout: number): void {
    this.mutex = new Mutex(100, timeout);
  }

  /**
   * Waits for the debugger connected
   */
  public async waitConnected(): Promise<GdbClient> {
    if (!this.connected) {
      await new Promise<void>((resolve) => this.once("connected", resolve));
    }
    return this;
  }

  /**
   * Checks if the debugger connected.
   * @return true if it is connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

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

  /**
   * Ask the frames count
   * @param thread Thread identifier
   */
  public async getFramesCount(thread: Thread): Promise<number> {
    if (thread.isCPU()) {
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

  /**
   * Ask the debugger to step until the pc is in range
   * @param thread Thread selected
   * @param startAddress Start address for the stop range included
   * @param endAddress Start address for the stop range excluded
   */
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
        thread.marshall();
    } else {
      // Not a real GDB command...
      message = "n";
    }
    thread.setState(ThreadState.STEPPING);
    await this.request(message, PacketType.STOP);
  }

  /**
   * Ask the debugger to step in
   * @param thread Thread selected
   */
  public async stepIn(thread: Thread): Promise<void> {
    const message = this.supportVCont ? "vCont;s:" + thread.marshall() : "s";
    thread.setState(ThreadState.STEPPING);
    await this.request(message, PacketType.STOP);
  }

  /**
   * Reads part of the memory
   * @param address Memory address
   * @param length Length to retrieve
   * @return String returned by the server = bytes in hexa
   */
  public async getMemory(address: number, length: number): Promise<string> {
    return this.request(
      "m" + formatNumber(address) + "," + formatNumber(length),
      PacketType.UNKNOWN
    );
  }

  /**
   * Set values to memory, from address.
   * @param address Address to write
   * @param dataToSend Data to send
   */
  public async setMemory(address: number, dataToSend: string): Promise<void> {
    const size = Math.ceil(dataToSend.length / 2);
    await this.request(
      "M" + formatNumber(address) + "," + size + ":" + dataToSend,
      PacketType.OK
    );
  }

  /**
   * Retrieves all the register values
   */
  public async getRegisters(thread?: Thread | null): Promise<number[]> {
    const command = thread ? "Hg" + thread?.getThreadId() : "g";
    const message = await this.request(command, PacketType.UNKNOWN);
    const registers: number[] = [];

    const regCount = Math.floor(message.length / 8);
    for (let i = 0; i < regCount; i++) {
      const value = parseInt(message.substring(i * 8, (i + 1) * 8), 16);
      registers.push(value);
    }
    return registers;
  }

  /**
   * Reads a register value
   */
  public async getRegister(regIdx: number): Promise<number> {
    const data = await this.request(
      "p" + formatNumber(regIdx),
      PacketType.UNKNOWN
    );
    return parseInt(data, 16);
  }

  /**
   * Reads the thread id's
   */
  public async getThreadIds(): Promise<Thread[]> {
    const unlock = await this.mutex.capture("getThreadIds");
    try {
      const data = await this.request("qfThreadInfo", PacketType.UNKNOWN);
      return this.parseThreadsMessage(data);
    } finally {
      unlock();
    }
  }

  /**
   * Ask for the status of the current stop
   */
  public async getHaltStatus(): Promise<HaltStatus[]> {
    const returnedHaltStatus: HaltStatus[] = [];
    const response = await this.request("?", PacketType.STOP);
    if (response.indexOf("OK") < 0) {
      returnedHaltStatus.push(this.parseHaltStatus(response));
    }
    return returnedHaltStatus;
  }

  /**
   * Ask for a pause
   *
   * @param thread Thread to pause
   */
  public async pause(thread: Thread): Promise<void> {
    const message = this.supportVCont
      ? "vCont;t:" + thread.marshall()
      : "vCtrlC";
    thread.setState(ThreadState.STEPPING);
    await this.request(message, PacketType.STOP);
  }

  /**
   * Continue the execution
   */
  public async continueExecution(thread: Thread): Promise<void> {
    const message = this.supportVCont ? "vCont;c:" + thread.marshall() : "c";
    thread.setState(ThreadState.RUNNING);
    await this.request(message, null, false);
  }

  /**
   * Sets tha value of a register
   */
  public async setRegister(regIdx: number, value: string): Promise<string> {
    // Verify that the value is an hex
    const valueRegExp = /[a-z\d]{1,8}/i;
    if (!valueRegExp.test(value)) {
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

  public async monitor(command: string): Promise<string> {
    const response = await this.request("qRcmd," + asciiToHex(command), null);
    return response;
  }

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

  /**
   * Method to destroy the connection.
   */
  public destroy(): void {
    this.socket.destroy();
  }

  // Internals:

  /** Default handler for the on data event*/
  private defaultOnDataHandler = (packet: Packet): boolean => {
    logger.log(
      `[GDB] defaultOnDataHandler (type : ${
        PacketType[packet.getType()]
      }, notification : ${packet.isNotification()}) : --> ${packet.getMessage()}`
    );
    const consumed = false;
    switch (packet.getType()) {
      case PacketType.STOP:
        this.handleStop(packet.getMessage());
        break;
      case PacketType.END:
        this.sendEvent("end");
        break;
      case PacketType.MINUS:
        console.error("Unsupported packet : '-'");
        this.sendEvent("error", new Error("Unsupported packet : '-'"));
        break;
      case PacketType.SEGMENT:
        this.handleSegments(packet.getMessage());
        break;
      case PacketType.OK:
      case PacketType.PLUS:
      case PacketType.UNKNOWN:
      default:
        break;
    }
    return consumed;
  };

  /**
   * Method to precess the generics messages
   * @param data Data to parse
   */
  private onData(data: Buffer): void {
    const packets = Packet.parseData(data);
    for (const packet of packets) {
      // plus packet are acknowledge - to be ignored
      if (packet.getType() === PacketType.OUTPUT) {
        try {
          let msg = hexUTF8StringToUTF8(packet.getMessage().substring(1));
          if (!msg.startsWith("PRF: ")) {
            // don't display profiler output, handled by profiler
            if (msg.startsWith("DBG: ")) {
              // user output (KPrintF, etc.)
              msg = msg.substring(5); // remove "DBG: " prefix added by uaelib.cpp
            }
            logger.log(`[GDB] server output : ${msg}`);
          }
        } catch (err) {
          logger.error(`[GDB] Error parsing server output : ${err}`);
        }
      } else if (packet.getType() !== PacketType.PLUS) {
        this.receivedDataManager.trigger(packet);
      }
    }
  }

  /**
   * Main send function.
   * If sends a text in the format "$mymessage#checksum"
   * @param requestText Text to send
   * @param responseType Type of the answer expected - null is any
   * @param responseExpected if true not waiting response
   * @return a Promise with the response contents - or a rejection
   */
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
        const packet = await this.receivedDataManager.waitData({
          handle: (testedPacket: Packet): boolean => {
            return (
              responseType === null ||
              testedPacket.getType() === PacketType.ERROR ||
              responseType === testedPacket.getType()
            );
          },
        });

        if (!packet) {
          throw new Error("No response from the emulator");
        }

        const response = packet.getMessage();
        logger.log(`[GDB] <-- req: ${requestText} res: ${response}`);

        if (packet.getType() === PacketType.ERROR) {
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

  /**
   * Ask the frame index for pc offset
   */
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

  /**
   * Parses a threads response
   * @param threadsMessage Message containing the threads
   * @returns array of threads
   */
  private parseThreadsMessage(threadsMessage: string): Thread[] {
    let pData = threadsMessage;
    if (pData.startsWith("m")) {
      pData = pData.substring(1).trim();
    }
    if (pData.endsWith("l")) {
      pData = pData.substring(0, pData.length - 1);
    }
    if (pData.endsWith(",")) {
      pData = pData.substring(0, pData.length - 1);
    }
    const returnedThreads: Thread[] = [];
    for (const elm of pData.split(",")) {
      const th = Thread.parse(elm);
      returnedThreads.push(th);
      this.threads.set(th.getId(), th);
      this.threadsNative.set(elm, th);
    }
    return returnedThreads;
  }

  /**
   * Sends an event
   * @param event Event to send
   * @param args Arguments
   */
  private sendEvent<U extends keyof Events>(
    event: U,
    ...args: Parameters<Events[U]>
  ): void {
    setImmediate(() => {
      this.eventEmitter.emit(event, ...args);
    });
  }

  // Event handlers:

  /**
   * Parse of the segment message :
   *          AS;addr;size;add2;size
   *  or      AS addr;size;add2;size
   * @param segmentReply The message containing the segments
   */
  private handleSegments(segmentReply: string): void {
    const segs = segmentReply.substring(2).split(";"); // removing "AS"
    const segments: Segment[] = [];
    // The segments message begins with the keyword AS
    let index = 0;
    for (let i = 1; i < segs.length - 1; i += 2) {
      const address = segs[i];
      const size = segs[i + 1];
      segments.push({
        id: index,
        address: parseInt(address, 16),
        size: parseInt(size, 16),
      });
      index++;
    }
    this.sendEvent("segments", segments);
  }

  private handleStop(message: string): void {
    const haltStatus = this.parseHaltStatus(message);
    this.sendEvent("stop", haltStatus);
  }

  // Message parsing:

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
    const details = signalDescriptions[code] || "Other exception";
    let posString = "";
    let registers = new Map<number, number>();
    let threadId: number | undefined;
    if (parameters) {
      [threadId, registers] = this.parseHaltParameters(parameters);
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

  private parseHaltParameters(
    parameters: string
  ): [number | undefined, Map<number, number>] {
    const map = new Map<number, number>();
    let threadId;
    const elms = parameters.trim().split(";");
    for (const elm of elms) {
      const kv = elm.split(":");
      if (kv.length > 1) {
        if ("thread" === kv[0]) {
          threadId = parseInt(kv[1]);
        } else if (kv.length > 0) {
          map.set(parseInt(kv[0], 16), parseInt(kv[1], 16));
        }
      }
    }
    return [threadId, map];
  }
}

export class GdbError extends Error {
  public errorType: string;
  constructor(errorType: string) {
    super();
    this.errorType = errorType.toUpperCase();
    this.name = "GdbError";
    const msg = errorMessages[this.errorType as keyof typeof errorMessages];
    if (msg) {
      this.message = msg;
    } else {
      this.message = "Error code received: '" + this.errorType + "'";
    }
  }
}

// Utils:

/**
 * Calculates a checksum for the text
 * @param text Text to send
 */
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

/**
 * Prepares a string to be send: checksum + start char
 * @param text Text to be sent
 */
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

/**
 * Formats a number to send
 * @param n number
 */
function formatNumber(n: number): string {
  if (n === 0) {
    return "0";
  }
  return n.toString(16);
}
