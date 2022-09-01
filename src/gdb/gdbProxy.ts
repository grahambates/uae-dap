import { Socket } from "net";
import { EventEmitter } from "events";
import { Mutex } from "../utils/mutex";
import { Thread, ThreadState, ThreadId } from "./threads";
import { GdbReceivedDataManager } from "./events";
import { Packet, PacketType } from "./packets";
import { hexUTF8StringToUTF8, asciiToHex } from "../utils/strings";
import { logger } from "@vscode/debugadapter";
import { SegmentOffset } from "../fileInfo";
import {
  AccessType,
  Breakpoint,
  isDataBreakpoint,
  isExceptionBreakpoint,
} from "../breakpoints";

/** Status for the current halt */
export interface HaltStatus {
  code: number;
  details: string;
  registers: Map<number, number>;
  thread?: Thread;
}

/** StackFrame position */
export interface StackPosition {
  /** Index of the position */
  index: number;
  /** Index of the stack frame */
  stackFrameIndex: number;
  /** Segment identifier */
  segmentId: number;
  /** Offset relative to the segment*/
  offset: number;
  /** Pc of the frame */
  pc: number;
}

/** Register value */
export interface Register {
  name: string;
  value: number;
}

/** Memory segment */
export interface Segment {
  id: number;
  name?: string;
  address: number;
  size: number;
}

type Events = {
  gdbConnected: () => void;
  stopOnEntry: (threadId: number) => void;
  stopOnStep: (threadId: number, preserveFocusHint?: boolean) => void;
  stopOnPause: (threadId: number) => void;
  stopOnBreakpoint: (threadId: number) => void;
  segmentsUpdated: (segments: Segment[]) => void;
  stopOnException: (haltStatus: HaltStatus, threadId: number) => void;
  continueThread: (threadId: number, allThreadsContinued?: boolean) => void;
  breakpointValidated: (bp: Breakpoint) => void;
  threadStarted: (threadId: number) => void;
  end: () => void;
  error: (err: Error) => void;
};

/** Halt signal */
enum Signal {
  // Interrupt
  INT = 2,
  // Illegal instruction
  ILL = 4,
  // Trace/breakpoint trap
  TRAP = 5,
  // Emulation trap
  EMT = 7,
  // Arithmetic exception
  FPE = 8,
  // Bus error
  BUS = 10,
  // Segmentation fault
  SEGV = 11,
}

// Registers Indexes
// order of registers are assumed to be
// d0-d7, a0-a7, sr, pc [optional fp0-fp7, control, iar]
const REGISTER_D0_INDEX = 0; // -> 0 to 7
const REGISTER_A0_INDEX = 8; // -> 8 to 15
const REGISTER_SR_INDEX = 16;
const REGISTER_PC_INDEX = 17;
const REGISTER_COPPER_ADDR_INDEX = 28;

/** Code to set the debugger to the current frame index */
const DEFAULT_FRAME_INDEX = -1;

/** Supported functions */
const SUPPORT_STRING =
  "qSupported:QStartNoAckMode+;multiprocess+;vContSupported+;QNonStop+";

/** Labels for SR bits */
const SR_LABELS = [
  "T1",
  "T0",
  "S",
  "M",
  null,
  "I",
  "I",
  "I",
  null,
  null,
  null,
  "X",
  "N",
  "Z",
  "V",
  "C",
];

/**
 * Class to contact the fs-UAE GDB server.
 */
export class GdbProxy {
  /** Socket to connect */
  private socket: Socket;
  /** Segments of memory */
  private segments?: Segment[];
  /** Stop on entry asked */
  private stopOnEntryRequested = false;
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
  /** Lock for sendPacketString function */
  private sendPacketStringLock?: () => void;
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
          const data = await this.sendPacketString(
            SUPPORT_STRING,
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
            await this.sendPacketString("QStartNoAckMode", PacketType.OK);
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
  public async waitConnected(): Promise<void> {
    if (!this.connected) {
      await new Promise<void>((resolve) =>
        this.once("gdbConnected", () => {
          resolve();
        })
      );
    }
  }

  /**
   * Checks if the debugger connected.
   * @return true if it is connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Message to initialize the program
   */
  public async initProgram(): Promise<void> {
    this.connected = true;
    this.sendEvent("gdbConnected");
    await this.updateSegments();
    // Call for thread dump
    const threads = await this.getThreadIds();
    for (const th of threads) {
      this.sendEvent("threadStarted", th.getId());
    }
  }

  /**
   * Ask for a new breakpoint
   * @param breakpoint breakpoint to add
   * @return Promise with a breakpoint
   */
  public async setBreakpoint(breakpoint: Breakpoint): Promise<void> {
    const segmentId = breakpoint.segmentId;
    const offset = breakpoint.offset;
    if (!this.socket.writable) {
      throw new Error("The Gdb connection is not opened");
    }
    await this.waitConnected();
    if (
      this.segments &&
      segmentId !== undefined &&
      segmentId >= this.segments.length
    ) {
      throw new Error("Invalid breakpoint segment id: " + segmentId);
    }

    let message: string;
    if (isExceptionBreakpoint(breakpoint)) {
      // Exception:
      const expMskHex = formatNumber(breakpoint.exceptionMask);
      const expMskHexSz = formatNumber(expMskHex.length);
      message = "Z1,0,0;X" + expMskHexSz + "," + expMskHex;
    } else if (
      isDataBreakpoint(breakpoint) &&
      breakpoint.size &&
      breakpoint.size > 0 &&
      breakpoint.accessType
    ) {
      // Data breakpoint:
      let code: number;
      switch (breakpoint.accessType) {
        case AccessType.READ:
          code = 2;
          break;
        case AccessType.WRITE:
          code = 3;
          break;
        case AccessType.READWRITE:
          code = 4;
          break;
      }
      message = `Z${code},${formatNumber(offset)},${formatNumber(
        breakpoint.size
      )}`;
    } else if (offset >= 0) {
      // Has offset:
      let offsetStr = "";
      if (segmentId !== undefined && segmentId >= 0) {
        offsetStr = formatNumber(this.offsetToAbsolute(segmentId, offset));
      } else {
        offsetStr = formatNumber(offset);
      }
      message = "Z0," + offsetStr;
    } else {
      throw new Error("Invalid breakpoint offset");
    }
    await this.sendPacketString(message, PacketType.OK);
    breakpoint.verified = true;
    breakpoint.message = breakpoint.defaultMessage;
    this.sendEvent("breakpointValidated", breakpoint);
  }

  /**
   * Ask for a breakpoint removal
   * @param breakpoint breakpoint to remove
   */
  public async removeBreakpoint(breakpoint: Breakpoint): Promise<void> {
    const segmentId = breakpoint.segmentId;
    const offset = breakpoint.offset;
    let message: string | undefined = undefined;
    await this.waitConnected();
    if (
      this.segments &&
      segmentId !== undefined &&
      segmentId < this.segments.length
    ) {
      message = "z0," + formatNumber(this.offsetToAbsolute(segmentId, offset));
    } else if (offset > 0) {
      if (
        isDataBreakpoint(breakpoint) &&
        breakpoint.size &&
        breakpoint.size > 0 &&
        breakpoint.accessType
      ) {
        let code: number;
        switch (breakpoint.accessType) {
          case AccessType.READ:
            code = 2;
            break;
          case AccessType.WRITE:
            code = 3;
            break;
          case AccessType.READWRITE:
            code = 4;
            break;
        }
        // Data breakpoint
        message = `z${code},${formatNumber(offset)}`;
      } else {
        message = "z0," + formatNumber(offset);
      }
    } else if (isExceptionBreakpoint(breakpoint)) {
      message = "z1," + formatNumber(breakpoint.exceptionMask);
    } else {
      throw new Error(
        "No segments are defined or segmentId is invalid, is the debugger connected?"
      );
    }
    await this.sendPacketString(message, PacketType.OK);
  }

  /**
   * Ask the frames count
   * @param thread Thread identifier
   */
  public async getFramesCount(thread: Thread): Promise<number> {
    if (thread.getThreadId() === ThreadId.CPU) {
      const message = "qTStatus";
      const data = await this.sendPacketString(message, PacketType.QTSTATUS);
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
   * Gets the current stack frame
   *
   * @param thread Thread identifier
   */
  public async stack(thread: Thread): Promise<StackPosition[]> {
    const unlock = await this.mutex.capture("stack");
    try {
      const stackPositions = new Array<StackPosition>();
      // Retrieve the current frame
      let stackPosition = await this.getStackPosition(
        thread,
        DEFAULT_FRAME_INDEX
      );
      stackPositions.push(stackPosition);
      if (thread.getThreadId() === ThreadId.CPU) {
        // Retrieve the current frame count
        const stackSize = await this.getFramesCount(thread);
        for (let i = stackSize - 1; i >= 0; i--) {
          try {
            stackPosition = await this.getStackPosition(thread, i);
            stackPositions.push(stackPosition);
          } catch (err) {
            console.error(err);
          }
        }
      }
      return stackPositions;
    } finally {
      unlock();
    }
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
      // TODO: Remove hack to step over... Put real addresses
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
    await this.sendPacketString(message, PacketType.STOP);
    this.sendStopOnStepEvent(thread);
  }

  /**
   * Ask the debugger to step in
   * @param thread Thread selected
   */
  public async stepIn(thread: Thread): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      message = "vCont;s:" + thread.marshall();
    } else {
      message = "s";
    }
    thread.setState(ThreadState.STEPPING);
    await this.sendPacketString(message, PacketType.STOP);
    this.sendStopOnStepEvent(thread);
  }

  /**
   * Retrieves all the register values
   */
  public async registers(
    frameId: number | null,
    thread?: Thread | null
  ): Promise<Register[]> {
    const unlock = await this.mutex.capture("selectFrame");
    try {
      if (frameId !== null) {
        // sets the current frameId
        await this.selectFrame(frameId, null);
      }
      let command = "g";
      if (thread !== null) {
        command = "Hg" + thread?.getThreadId();
      }
      const message = await this.sendPacketString(command, PacketType.UNKNOWN);
      let registers = new Array<Register>();
      let pos = 0;
      let letter = "d";
      let v = "";
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 8; i++) {
          const name = letter + i;
          v = message.slice(pos, pos + 8);
          registers.push({
            name: name,
            value: parseInt(v, 16),
          });
          pos += 8;
        }
        letter = "a";
      }
      v = message.slice(pos, pos + 8);
      pos += 8;
      const sr = parseInt(v, 16);
      registers.push({
        name: "sr",
        value: sr,
      });
      registers = registers.concat(getSRDetailedValues(sr));
      v = message.slice(pos, pos + 8);
      const pc = parseInt(v, 16);
      registers.unshift({
        name: "pc",
        value: pc,
      });
      return registers;
    } finally {
      unlock();
    }
  }

  /**
   * Reads all the memory from a segment
   * @param segmentId Segment ID
   * @return String returned by the server = bytes in hexa
   */
  public async getSegmentMemory(segmentId: number): Promise<string> {
    if (this.segments) {
      if (segmentId < this.segments.length) {
        const segment = this.segments[segmentId];
        return this.getMemory(segment.address, segment.size);
      } else {
        throw new Error(`Segment Id #${segmentId} not found`);
      }
    } else {
      throw new Error("No segments stored in debugger");
    }
  }

  /**
   * Reads part of the memory
   * @param address Memory address
   * @param length Length to retrieve
   * @return String returned by the server = bytes in hexa
   */
  public async getMemory(address: number, length: number): Promise<string> {
    return this.sendPacketString(
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
    await this.sendPacketString(
      "M" + formatNumber(address) + "," + size + ":" + dataToSend,
      PacketType.OK
    );
  }

  /**
   * Reads a register value
   * @param name Name of the register a1, a2, etc..
   */
  public async getRegister(
    name: string,
    frameIndex: number | undefined
  ): Promise<[number, number]> {
    const unlock = await this.mutex.capture("selectFrame");
    let returnedFrameIndex = DEFAULT_FRAME_INDEX;
    try {
      // the current frame
      if (frameIndex !== undefined) {
        const sReturnedFrameIndex = await this.selectFrame(frameIndex, null);
        if (sReturnedFrameIndex !== undefined) {
          returnedFrameIndex = sReturnedFrameIndex;
        }
        if (
          frameIndex !== DEFAULT_FRAME_INDEX &&
          sReturnedFrameIndex !== frameIndex
        ) {
          throw new Error(
            `Error during frame selection asking ${frameIndex} returned ${sReturnedFrameIndex}`
          );
        }
      }
      const regIdx = this.getRegisterIndex(name);
      if (regIdx !== null) {
        const data = await this.sendPacketString(
          "p" + formatNumber(regIdx),
          PacketType.UNKNOWN
        );
        return [parseInt(data, 16), returnedFrameIndex];
      } else {
        throw new Error("No index found for register: " + name);
      }
    } finally {
      unlock();
    }
  }

  /**
   * Reads the thread id's
   */
  public async getThreadIds(): Promise<Thread[]> {
    const unlock = await this.mutex.capture("getThreadIds");
    try {
      if (this.threads.size <= 0) {
        const data = await this.sendPacketString(
          "qfThreadInfo",
          PacketType.UNKNOWN
        );
        return this.parseThreadsMessage(data);
      } else {
        return Array.from(this.threads.values());
      }
    } finally {
      unlock();
    }
  }

  /**
   * Ask for the status of the current stop
   */
  public async getHaltStatus(): Promise<HaltStatus[]> {
    const returnedHaltStatus = new Array<HaltStatus>();
    const response = await this.sendPacketString("?", PacketType.STOP);
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
    let message: string;
    if (this.supportVCont) {
      message = "vCont;t:" + thread.marshall();
    } else {
      // Not a real GDB command...
      message = "vCtrlC";
    }
    thread.setState(ThreadState.STEPPING);
    await this.sendPacketString(message, PacketType.STOP);
    this.sendEvent("stopOnPause", thread.getId());
  }

  /**
   * Continue the execution
   */
  public async continueExecution(thread: Thread): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      message = "vCont;c:" + thread.marshall();
    } else {
      // Not a real GDB command...
      message = "c";
    }
    thread.setState(ThreadState.RUNNING);
    await this.sendPacketString(message, null, false);
    this.sendEvent("continueThread", thread.getId(), true);
  }

  /**
   * Sets tha value of a register
   * @param name Name of the register
   * @param value New value of the register
   */
  public async setRegister(name: string, value: string): Promise<string> {
    // Verify that the value is an hex
    const valueRegExp = /[a-z\d]{1,8}/i;
    if (valueRegExp.test(value)) {
      const regIdx = this.getRegisterIndex(name);
      if (regIdx !== null) {
        const message = "P" + regIdx.toString(16) + "=" + value;
        const response = await this.sendPacketString(message, null);
        if (response && response.indexOf("OK") >= 0) {
          return value;
        } else {
          throw new Error("Error setting the register value");
        }
      } else {
        throw new Error("Invalid register name: " + name);
      }
    } else {
      throw new Error("The value must be a hex string with at most 8 digits");
    }
  }

  public async monitor(command: string): Promise<string> {
    const response = await this.sendPacketString(
      "qRcmd," + asciiToHex(command),
      null,
      false
    );
    return response;
  }

  /**
   * Returns a stored thread from it's id.
   */
  public getThread(gdbThreadId: number): Thread | undefined {
    return this.threads.get(gdbThreadId);
  }

  /**
   * Returns the current CPU thread...
   */
  public getCurrentCpuThread(): Thread | undefined {
    return this.getThreadFromSysThreadId(ThreadId.CPU);
  }

  /**
   * Returns the current array of segments
   * @return array of segments or undefined
   */
  public getSegments(): Segment[] | undefined {
    return this.segments;
  }

  /**
   * Adds a segment retrieved from the hunk file
   * @param segment Segment to add
   * @return the start address of the segment
   */
  public addSegment(segment: Segment): number {
    if (this.segments) {
      const lastSegment = this.segments[this.segments.length - 1];
      segment.address = lastSegment.address + lastSegment.size;
      this.segments.push(segment);
      return segment.size;
    }
    return -1;
  }

  /**
   * Transforms an absolute offset to a segmentsId and local offset
   * @param offset Absolute offset
   * @return Array with segmentId and a local offset
   */
  public absoluteToOffset(offset: number): SegmentOffset {
    if (this.segments) {
      let segmentId = 0;
      for (const segment of this.segments) {
        if (
          offset >= segment.address &&
          offset <= segment.address + segment.size
        ) {
          return { segmentId, offset: offset - segment.address };
        }
        segmentId++;
      }
    }
    return { segmentId: -1, offset };
  }

  /**
   * Transforms an offset in local segment coordinated to an absolute offset
   */
  public offsetToAbsolute(segmentId: number, offset: number): number {
    if (this.segments) {
      if (segmentId < this.segments.length) {
        return this.segments[segmentId].address + offset;
      }
    }
    return offset;
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
        this.parseStop(packet.getMessage());
        break;
      case PacketType.END:
        this.sendEvent("end");
        break;
      case PacketType.MINUS:
        console.error("Unsupported packet : '-'");
        this.sendEvent("error", new Error("Unsupported packet : '-'"));
        break;
      case PacketType.SEGMENT:
        this.parseSegments(packet.getMessage());
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

  private async updateSegments(): Promise<void> {
    const segmentReply = await this.sendPacketString(
      "qOffsets",
      PacketType.UNKNOWN
    );
    // expected return message : TextSeg=00c03350;DataSeg=00c03350
    const segs = segmentReply.split(";");
    this.segments = new Array<Segment>();
    // The segments message begins with the keyword AS
    let segIdx = 0;
    for (const seg of segs) {
      segIdx++;
      let name: string;
      let address: string;
      const segElms = seg.split("=");
      if (segElms.length > 1) {
        name = segElms[0];
        address = segElms[1];
      } else {
        name = `Segment${segIdx}`;
        address = segElms[0];
      }
      this.segments.push({
        id: segIdx - 1,
        name: name,
        address: parseInt(address, 16),
        size: 0,
      });
    }
    this.sendEvent("segmentsUpdated", this.segments);
  }

  /**
   * Main send function.
   * If sends a text in the format "$mymessage#checksum"
   * @param text Text to send
   * @param expectedType Type of the answer expected - null is any
   * @param answerExpected if true not waiting response
   * @return a Promise with the response contents - or a rejection
   */
  private async sendPacketString(
    text: string,
    expectedType: PacketType | null,
    answerExpected = true
  ): Promise<string> {
    let returnedMessage = "";
    const dataToSend = formatString(text);
    if (this.socket.writable) {
      this.sendPacketStringLock = await this.mutex.capture("sendPacketString");
      try {
        let expectedTypeName: string;
        if (expectedType) {
          expectedTypeName = PacketType[expectedType];
        } else {
          expectedTypeName = "null";
        }
        logger.log(`[GDB] --> ${text} / ${expectedTypeName}`);
        let p;
        if (answerExpected) {
          p = this.receivedDataManager.waitData({
            handle: (testedPacket: Packet): boolean => {
              return (
                expectedType === null ||
                testedPacket.getType() === PacketType.ERROR ||
                expectedType === testedPacket.getType()
              );
            },
          });
        }
        this.socket.write(dataToSend);
        if (answerExpected) {
          const packet = await p;
          if (packet) {
            returnedMessage = packet.getMessage();
            logger.log(`[GDB] <-- req: ${text} res: ${returnedMessage}`);

            if (packet.getType() === PacketType.ERROR) {
              throw this.parseError(returnedMessage);
            }
          } else {
            throw new Error("No response from the emulator");
          }
        }
      } finally {
        if (this.sendPacketStringLock) {
          this.sendPacketStringLock();
          this.sendPacketStringLock = undefined;
        }
      }
    } else {
      throw new Error("Socket can't be written");
    }
    return returnedMessage;
  }

  /**
   * Ask the frame index for pc offset
   */
  private async selectFrame(
    num: number | null,
    pc: number | null
  ): Promise<number> {
    try {
      let message = "QTFrame:";
      if (num !== null) {
        if (num < 0) {
          message += "ffffffff";
          await this.sendPacketString(message, PacketType.OK);
          return DEFAULT_FRAME_INDEX;
        } else {
          message += formatNumber(num);
        }
      } else if (pc !== null) {
        message += "pc:" + formatNumber(pc);
      } else {
        throw new Error("No arguments to select a frame");
      }
      const data = await this.sendPacketString(message, PacketType.FRAME);
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
   * Retrieves the stack position for a frame
   *
   * @param thread Thread identifier
   * @param frameIndex Index of the frame selected
   */
  private async getStackPosition(
    thread: Thread,
    frameIndex: number
  ): Promise<StackPosition> {
    if (thread.getThreadId() === ThreadId.CPU) {
      // Get the current frame
      const [pc, index] = await this.getRegister("pc", frameIndex);
      if (pc) {
        const { segmentId, offset } = this.absoluteToOffset(pc);
        return {
          index: frameIndex,
          stackFrameIndex: index + 1,
          segmentId: segmentId,
          offset: offset,
          pc: pc,
        };
      } else {
        throw new Error(
          "Error retrieving stack frame for index " +
            frameIndex +
            ": pc not retrieved"
        );
      }
    } else if (thread.getThreadId() === ThreadId.COP) {
      // Retrieve the stack position from the copper
      const haltStatus = await this.getHaltStatus();
      if (haltStatus) {
        const registersValues = await this.registers(null, thread);
        if (registersValues) {
          let copperPcValue = 0;
          for (const v of registersValues) {
            if (v.name === "pc") {
              copperPcValue = v.value;
              break;
            }
          }
          return {
            index: frameIndex * 1000,
            stackFrameIndex: 1,
            segmentId: -10,
            offset: 0,
            pc: copperPcValue,
          };
        } else {
          throw new Error("No stack frame returned");
        }
      }
    }
    throw new Error("No frames for thread: " + thread.getDisplayName());
  }

  /**
   * Send a stop on step event for thread
   * @param thread selected thread
   */
  private sendStopOnStepEvent(thread: Thread) {
    for (const thId of this.threads.keys()) {
      if (thId !== thread.getId()) {
        this.sendEvent("stopOnStep", thId, true);
      }
    }
    this.sendEvent("stopOnStep", thread.getId(), false);
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

  /**
   * Parse of the segment message :
   *          AS;addr;size;add2;size
   *  or      AS addr;size;add2;size
   * @param segmentReply The message containing the segments
   */
  private parseSegments(segmentReply: string): void {
    const segs = segmentReply.substring(2).split(";"); // removing "AS"
    this.segments = [];
    // The segments message begins with the keyword AS
    let index = 0;
    for (let i = 1; i < segs.length - 1; i += 2) {
      const address = segs[i];
      const size = segs[i + 1];
      this.segments.push({
        id: index,
        address: parseInt(address, 16),
        size: parseInt(size, 16),
      });
      index++;
    }
    this.sendEvent("segmentsUpdated", this.segments);
  }

  private async parseStop(message: string): Promise<void> {
    const haltStatus = this.parseHaltStatus(message);
    const currentCpuThread = this.getCurrentCpuThread();
    let currentThreadId = -1;
    if (haltStatus.thread) {
      currentThreadId = haltStatus.thread.getId();
    } else if (currentCpuThread) {
      currentThreadId = currentCpuThread.getId();
    }
    switch (haltStatus.code) {
      case Signal.TRAP: // Trace/breakpoint trap
        // A breakpoint has been reached
        if (this.stopOnEntryRequested) {
          this.stopOnEntryRequested = false;
          this.sendEvent("stopOnEntry", currentThreadId);
        } else {
          this.sendEvent("stopOnBreakpoint", currentThreadId);
        }
        break;
      case Signal.EMT: // Emulation trap -> copper breakpoint
        // Exception reached
        this.sendEvent("stopOnBreakpoint", currentThreadId);
        break;
      default:
        // Exception reached
        this.sendEvent("stopOnException", haltStatus, currentThreadId);
        break;
    }
  }

  private parseHaltParameters(
    parameters: string
  ): [Thread | undefined, Map<number, number>] {
    const map = new Map<number, number>();
    let thread;
    const elms = parameters.trim().split(";");
    for (const elm of elms) {
      const kv = elm.split(":");
      if (kv.length > 1) {
        if ("thread" === kv[0]) {
          thread = this.threadsNative.get(kv[1]);
        } else if (kv.length > 0) {
          map.set(parseInt(kv[0], 16), parseInt(kv[1], 16));
        }
      }
    }
    return [thread, map];
  }

  /**
   * Parses the halt status
   * ‘TAAn1:r1;n2:r2;…’
   * @param message Message to be parsed
   */
  private parseHaltStatus(message: string): HaltStatus {
    // Retrieve the cause
    const sig = parseInt(message.substring(1, 3), 16);
    let parameters: string | null = null;
    if (message.length > 3) {
      parameters = message.substring(3);
    }
    let details = "";
    switch (sig) {
      case Signal.INT: // Interrupt
        details = "Interrupt";
        break;
      case Signal.ILL: // Illegal instruction
        details = "Illegal instruction";
        break;
      case Signal.TRAP: // Trace/breakpoint trap
        details = "Trace/breakpoint trap";
        break;
      case Signal.EMT: // Emulation trap
        details = "Emulation trap";
        break;
      case Signal.FPE: // Arithmetic exception
        details = "Arithmetic exception";
        break;
      case Signal.BUS: // Bus error
        details = "Bus error";
        break;
      case Signal.SEGV: // Segmentation fault
        details = "Segmentation fault";
        break;
      default:
        details = "Other exception";
        break;
    }
    let posString = "";
    let registersMap;
    let thread;
    if (parameters) {
      [thread, registersMap] = this.parseHaltParameters(parameters);
      const pc = registersMap.get(REGISTER_PC_INDEX);
      if (pc) {
        posString = " in $" + formatNumber(pc);
      }
      if (thread) {
        posString += " thread: " + thread.getDisplayName();
      }
    } else {
      registersMap = new Map<number, number>();
    }
    return {
      code: sig,
      details: "Exception " + sig + posString + ": " + details,
      thread: thread,
      registers: registersMap,
    };
  }

  /**
   * Gets the register index from it's name
   */
  private getRegisterIndex(name: string): number | null {
    if (name.length > 1) {
      const type = name.charAt(0);
      const idx = parseInt(name.charAt(1));
      if (type === "d") {
        return idx + REGISTER_D0_INDEX;
      } else if (type === "a") {
        return idx + REGISTER_A0_INDEX;
      } else if (name === "pc") {
        return REGISTER_PC_INDEX;
      } else if (name === "sr") {
        return REGISTER_SR_INDEX;
      } else if (name === "copper") {
        return REGISTER_COPPER_ADDR_INDEX;
      }
    }
    return null;
  }

  /**
   * Returns the thread with an amiga sys type
   */
  private getThreadFromSysThreadId(sysThreadId: ThreadId): Thread | undefined {
    for (const t of this.threads.values()) {
      if (t.getThreadId() === sysThreadId) {
        return t;
      }
    }
    return undefined;
  }

  /**
   * Parsing an error message
   * @param message Error message
   */
  private parseError(message: string): GdbError {
    const error = new GdbError(message);
    this.sendEvent("error", error);
    return error;
  }
}

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

/**
 * Retrieve the details of the status register
 * @param srValue Status Register value
 */
function getSRDetailedValues(srValue: number): Register[] {
  const registers: Register[] = [];
  let intMask = 0;
  let intPos = 2;
  for (let i = 0; i < SR_LABELS.length; i++) {
    const label = SR_LABELS[i];
    if (label !== null) {
      const mask = 1 << (15 - i);
      const b = srValue & mask;
      let vb = 0;
      if (b) {
        vb = 1;
      }
      if (label.startsWith("I")) {
        intMask = intMask | (vb << intPos);
        intPos--;
        if (intPos < 0) {
          registers.push({
            name: "SR_intmask",
            value: intMask,
          });
        }
      } else {
        registers.push({
          name: `SR_${label}`,
          value: vb,
        });
      }
    }
  }
  return registers;
}
