import { Socket } from "net";
import { EventEmitter } from "events";
import { Mutex } from "../utils/mutex";
import { GdbThread, GdbThreadState, GdbAmigaSysThreadId } from "./threads";
import { GdbReceivedDataManager } from "./events";
import { GdbPacket, GdbPacketType } from "./packets";
import { hexUTF8StringToUTF8, asciiToHex } from "../utils/strings";
import { DebugProtocol } from "@vscode/debugprotocol";
import { logger } from "@vscode/debugadapter";

/** Status for the current halt */
export interface GdbHaltStatus {
  code: number;
  details: string;
  registers: Map<number, number>;
  thread?: GdbThread;
}

/** Halt signal */
export enum GdbSignal {
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

/** Interface for a breakpoint */
export interface GdbBreakpoint extends DebugProtocol.Breakpoint {
  /**Type of breakpoint */
  type: GdbBreakpointType;
  /** Id for the segment if undefined it is an absolute offset*/
  segmentId?: number;
  /** Offset relative to the segment*/
  offset: number;
  /** default message for the breakpoint */
  defaultMessage?: string;
  condition?: string;
  hitCondition?: string;
  hitCount: number;
  logMessage?: string;
}

/**
 * Types of breakpoints
 */
export enum GdbBreakpointType {
  SOURCE,
  DATA,
  INSTRUCTION,
  EXCEPTION,
  TEMPORARY,
}

/**
 * Values to the access type of data breakpoint
 */
export enum GdbBreakpointAccessType {
  READ = "read",
  WRITE = "write",
  READWRITE = "readWrite",
}

export interface GdbBreakpointSource
  extends GdbBreakpoint,
    DebugProtocol.SourceBreakpoint {
  type: GdbBreakpointType.SOURCE;
  source: DebugProtocol.Source;
  line: number;
}

export interface GdbBreakpointData
  extends GdbBreakpoint,
    DebugProtocol.DataBreakpoint {
  type: GdbBreakpointType.DATA;
  /** Size of the memory watched */
  size?: number;
  /** The access type of the data. */
  accessType?: GdbBreakpointAccessType;
}

export interface GdbBreakpointException extends GdbBreakpoint {
  type: GdbBreakpointType.EXCEPTION;
  /** exception mask : if present it is an exception breakpoint */
  exceptionMask: number;
}

export interface GdbBreakpointInstruction extends GdbBreakpoint {
  type: GdbBreakpointType.INSTRUCTION;
}

export interface GdbBreakpointTemporary extends GdbBreakpoint {
  type: GdbBreakpointType.TEMPORARY;
}

export function isSourceBreakpoint(
  bp: GdbBreakpoint
): bp is GdbBreakpointSource {
  return (
    bp.source !== undefined && bp.line !== undefined && bp.id !== undefined
  );
}
export function isDataBreakpoint(bp: GdbBreakpoint): bp is GdbBreakpointData {
  return bp.type === GdbBreakpointType.DATA;
}
export function isInstructionBreakpoint(
  bp: GdbBreakpoint
): bp is GdbBreakpointInstruction {
  return bp.type === GdbBreakpointType.INSTRUCTION;
}
export function isExceptionBreakpoint(
  bp: GdbBreakpoint
): bp is GdbBreakpointException {
  return (bp as GdbBreakpointException).exceptionMask !== undefined;
}
export function isTemporaryBreakpoint(
  bp: GdbBreakpoint
): bp is GdbBreakpointTemporary {
  return bp.type === GdbBreakpointType.TEMPORARY;
}

/** StackFrame position */
export interface GdbStackPosition {
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
export interface GdbRegister {
  name: string;
  value: number;
}

/** Memory segment */
export interface GdbSegment {
  id: number;
  name?: string;
  address: number;
  size: number;
}

export type GdbEvents = {
  gdbConnected: () => void;
  stopOnEntry: (threadId: number) => void;
  stopOnStep: (threadId: number, preserveFocusHint?: boolean) => void;
  stopOnPause: (threadId: number) => void;
  stopOnBreakpoint: (threadId: number) => void;
  segmentsUpdated: (segments: GdbSegment[]) => void;
  stopOnException: (haltStatus: GdbHaltStatus, threadId: number) => void;
  continueThread: (threadId: number, allThreadsContinued?: boolean) => void;
  breakpointValidated: (bp: GdbBreakpoint) => void;
  threadStarted: (threadId: number) => void;
  end: () => void;
  error: (err: Error) => void;
};

export type GdbEvent = keyof GdbEvents;

/**
 * Class to contact the fs-UAE GDB server.
 */
export class GdbProxy {
  // Registers Indexes
  // order of registers are assumed to be
  // d0-d7, a0-a7, sr, pc [optional fp0-fp7, control, iar]
  static readonly REGISTER_D0_INDEX = 0; // -> 0 to 7
  static readonly REGISTER_A0_INDEX = 8; // -> 8 to 15
  static readonly REGISTER_SR_INDEX = 16;
  static readonly REGISTER_PC_INDEX = 17;
  static readonly REGISTER_FP0_INDEX = 18; // -> 18 to 25
  static readonly REGISTER_CTRL_INDEX = 26;
  static readonly REGISTER_IAR_INDEX = 27;
  static readonly REGISTER_COPPER_ADDR_INDEX = 28;
  /** Kind of breakpoints */
  static readonly BREAKPOINT_KIND_ABSOLUTE_ADDR = 100;
  /** Code to set the debugger to the current frame index */
  static readonly DEFAULT_FRAME_INDEX = -1;
  /** Supported functions */
  static readonly SUPPORT_STRING =
    "qSupported:QStartNoAckMode+;multiprocess+;vContSupported+;QNonStop+";
  /** Install new binaries exception message */
  static readonly BINARIES_ERROR =
    "Please install latest binaries from FS-UAE custom build https://github.com/prb28/vscode-amiga-assembly/releases";
  /** Unexpected return message */
  static readonly UNEXPECTED_RETURN_ERROR =
    "Unexpected return message for program launch command";
  /** Labels for SR bits */
  static readonly SR_LABELS = [
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
  /** Socket to connect */
  protected socket: Socket;
  /** Current source file */
  protected programFilename?: string;
  /** Segments of memory */
  protected segments?: GdbSegment[];
  /** Stop on entry asked */
  protected stopOnEntryRequested = false;
  /** Flag for the first stop - to install the breakpoints */
  protected firstStop = true;
  /** Mutex to just have one call to gdb */
  protected mutex = new Mutex(100, 60000);
  /** vCont commands are supported */
  protected supportVCont = false;
  /** Created threads */
  protected threads: Map<number, GdbThread>;
  /** Created threads indexed by native ids */
  protected threadsNative: Map<string, GdbThread>;
  /** function from parent to send all pending breakpoints */
  protected firstStopCallback?: () => Promise<void>;
  /** Manager for the received socket data */
  protected receivedDataManager: GdbReceivedDataManager;
  /** Lock for sendPacketString function */
  protected sendPacketStringLock?: () => void;
  /** If true the proxy is connected */
  protected connected = false;

  protected eventEmitter: EventEmitter;

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
    this.threads = new Map<number, GdbThread>();
    this.threadsNative = new Map<string, GdbThread>();
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
   * Declares the debugger connected.
   */
  public setConnected(): void {
    this.connected = true;
    this.sendEvent("gdbConnected");
  }

  /**
   * Checks if the debugger connected.
   * @return true if it is connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

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
            GdbProxy.SUPPORT_STRING,
            GdbPacketType.UNKNOWN
          );
          const returnedData = data;
          if (returnedData.indexOf("multiprocess+") >= 0) {
            GdbThread.setSupportMultiprocess(true);
          }
          if (returnedData.indexOf("vContSupported+") >= 0) {
            this.supportVCont = true;
          }
          if (returnedData.indexOf("QStartNoAckMode+") >= 0) {
            await this.sendPacketString("QStartNoAckMode", GdbPacketType.OK);
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
   * Method to destroy the connection.
   */
  public destroy(): void {
    this.socket.destroy();
  }

  /** Default handler for the on data event*/
  protected defaultOnDataHandler = (packet: GdbPacket): boolean => {
    logger.log(
      `[GDB] defaultOnDataHandler (type : ${
        GdbPacketType[packet.getType()]
      }, notification : ${packet.isNotification()}) : --> ${packet.getMessage()}`
    );
    const consumed = false;
    switch (packet.getType()) {
      case GdbPacketType.STOP:
        this.parseStop(packet.getMessage());
        break;
      case GdbPacketType.END:
        this.sendEvent("end");
        break;
      case GdbPacketType.MINUS:
        console.error("Unsupported packet : '-'");
        this.sendEvent("error", new Error("Unsupported packet : '-'"));
        break;
      case GdbPacketType.SEGMENT:
        this.parseSegments(packet.getMessage());
        break;
      case GdbPacketType.OK:
      case GdbPacketType.PLUS:
      case GdbPacketType.UNKNOWN:
      default:
        break;
    }
    return consumed;
  };

  /**
   * Method to precess the generics messages
   * @param data Data to parse
   */
  protected onData(data: Buffer): void {
    const packets = GdbPacket.parseData(data);
    for (const packet of packets) {
      // plus packet are acknowledge - to be ignored
      if (packet.getType() === GdbPacketType.OUTPUT) {
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
      } else if (packet.getType() !== GdbPacketType.PLUS) {
        this.receivedDataManager.trigger(packet);
      }
    }
  }

  /**
   * Message to initialize the program
   */
  public async initProgram(): Promise<void> {
    this.setConnected();
    await this.getQOffsets();
    // Call for thread dump
    const threads = await this.getThreadIds();
    for (const th of threads) {
      this.sendEvent("threadStarted", th.getId());
    }
  }

  /**
   * Message to load the program
   * @param programFilename Filename of the program with the local path
   * @param stopOnEntry If true we will stop" on entry
   */
  public async load(
    programFilename: string,
    stopOnEntry: boolean | undefined
  ): Promise<void> {
    if (this.programFilename !== programFilename) {
      this.programFilename = programFilename;
      const elms = this.programFilename.replace(/\\/g, "/").split("/");
      // Let fs-uae terminate before sending the run command
      // TODO : check if this is necessary
      await new Promise<void>((resolve, reject) =>
        setTimeout(async () => {
          this.stopOnEntryRequested = stopOnEntry !== undefined && stopOnEntry;
          const encodedProgramName = asciiToHex("dh0:" + elms[elms.length - 1]);
          // Call for segments
          try {
            const message = await this.sendPacketString(
              "vRun;" + encodedProgramName + ";",
              GdbPacketType.STOP
            );
            await this.initProgram();
            await this.parseStop(message);
            resolve();
          } catch (err) {
            reject(err);
          }
        }, 100)
      );
    }
  }

  public async getQOffsets(): Promise<void> {
    const segmentReply = await this.sendPacketString(
      "qOffsets",
      GdbPacketType.UNKNOWN
    );
    // expected return message : TextSeg=00c03350;DataSeg=00c03350
    const segs = segmentReply.split(";");
    this.segments = new Array<GdbSegment>();
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
   * Calculates a checksum for the text
   * @param text Text to send
   */
  public static calculateChecksum(text: string): string {
    let cs = 0;
    const buffer = Buffer.alloc(text.length, text);
    for (let i = 0; i < buffer.length; ++i) {
      cs += buffer[i];
    }
    cs = cs % 256;
    const s = GdbProxy.formatNumber(cs);
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
  public formatString(text: string): Buffer {
    const data = Buffer.alloc(text.length + 5);
    let offset = 0;
    data.write("$", offset++);
    data.write(text, offset);
    offset += text.length;
    data.write("#", offset++);
    data.write(GdbProxy.calculateChecksum(text), offset);
    offset += 2;
    data.writeInt8(0, offset);
    return data;
  }

  /**
   * Main send function.
   * If sends a text in the format "$mymessage#checksum"
   * @param text Text to send
   * @param expectedType Type of the answer expected - null is any
   * @param answerExpected if true not waiting response
   * @return a Promise with the response contents - or a rejection
   */
  public async sendPacketString(
    text: string,
    expectedType: GdbPacketType | null,
    answerExpected = true
  ): Promise<string> {
    let returnedMessage = "";
    const dataToSend = this.formatString(text);
    if (this.socket.writable) {
      this.sendPacketStringLock = await this.mutex.capture("sendPacketString");
      try {
        let expectedTypeName: string;
        if (expectedType) {
          expectedTypeName = GdbPacketType[expectedType];
        } else {
          expectedTypeName = "null";
        }
        logger.log(`[GDB] --> ${text} / ${expectedTypeName}`);
        let p;
        if (answerExpected) {
          p = this.receivedDataManager.waitData({
            handle: (testedPacket: GdbPacket): boolean => {
              return (
                expectedType === null ||
                testedPacket.getType() === GdbPacketType.ERROR ||
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

            if (packet.getType() === GdbPacketType.ERROR) {
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
   * Ask for a new breakpoint
   * @param breakpoint breakpoint to add
   * @return Promise with a breakpoint
   */
  public async setBreakpoint(breakpoint: GdbBreakpoint): Promise<void> {
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
      const expMskHex = GdbProxy.formatNumber(breakpoint.exceptionMask);
      const expMskHexSz = GdbProxy.formatNumber(expMskHex.length);
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
        case GdbBreakpointAccessType.READ:
          code = 2;
          break;
        case GdbBreakpointAccessType.WRITE:
          code = 3;
          break;
        case GdbBreakpointAccessType.READWRITE:
          code = 4;
          break;
      }
      message = `Z${code},${GdbProxy.formatNumber(
        offset
      )},${GdbProxy.formatNumber(breakpoint.size)}`;
    } else if (offset >= 0) {
      // Has offset:
      let offsetStr = "";
      if (segmentId !== undefined && segmentId >= 0) {
        offsetStr = GdbProxy.formatNumber(
          this.toAbsoluteOffset(segmentId, offset)
        );
      } else {
        offsetStr = GdbProxy.formatNumber(offset);
      }
      message = "Z0," + offsetStr;
    } else {
      throw new Error("Invalid breakpoint offset");
    }
    await this.sendPacketString(message, GdbPacketType.OK);
    breakpoint.verified = true;
    breakpoint.message = breakpoint.defaultMessage;
    this.sendEvent("breakpointValidated", breakpoint);
  }

  /**
   * Set async callback for first stop
   *
   * This can be used to send pending breakpoints
   */
  public onFirstStop(callback: () => Promise<void>) {
    this.firstStopCallback = callback;
  }

  /**
   * Ask for a breakpoint removal
   * @param breakpoint breakpoint to remove
   */
  public async removeBreakpoint(breakpoint: GdbBreakpoint): Promise<void> {
    const segmentId = breakpoint.segmentId;
    const offset = breakpoint.offset;
    let message: string | undefined = undefined;
    await this.waitConnected();
    if (
      this.segments &&
      segmentId !== undefined &&
      segmentId < this.segments.length
    ) {
      message =
        "z0," + GdbProxy.formatNumber(this.toAbsoluteOffset(segmentId, offset));
    } else if (offset > 0) {
      if (
        isDataBreakpoint(breakpoint) &&
        breakpoint.size &&
        breakpoint.size > 0 &&
        breakpoint.accessType
      ) {
        let code: number;
        switch (breakpoint.accessType) {
          case GdbBreakpointAccessType.READ:
            code = 2;
            break;
          case GdbBreakpointAccessType.WRITE:
            code = 3;
            break;
          case GdbBreakpointAccessType.READWRITE:
            code = 4;
            break;
        }
        // Data breakpoint
        message = `z${code},${GdbProxy.formatNumber(offset)}`;
      } else {
        message = "z0," + GdbProxy.formatNumber(offset);
      }
    } else if (isExceptionBreakpoint(breakpoint)) {
      message = "z1," + GdbProxy.formatNumber(breakpoint.exceptionMask);
    } else {
      throw new Error(
        "No segments are defined or segmentId is invalid, is the debugger connected?"
      );
    }
    await this.sendPacketString(message, GdbPacketType.OK);
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
          await this.sendPacketString(message, GdbPacketType.OK);
          return GdbProxy.DEFAULT_FRAME_INDEX;
        } else {
          message += GdbProxy.formatNumber(num);
        }
      } else if (pc !== null) {
        message += "pc:" + GdbProxy.formatNumber(pc);
      } else {
        throw new Error("No arguments to select a frame");
      }
      const data = await this.sendPacketString(message, GdbPacketType.FRAME);
      if (data === "F-1") {
        // No frame found
        return GdbProxy.DEFAULT_FRAME_INDEX;
      } else {
        let v = data.substring(1);
        const tPos = v.indexOf("T");
        if (tPos >= 0) {
          v = v.substring(0, tPos);
        }
        return parseInt(v, 16);
      }
    } catch (err) {
      return GdbProxy.DEFAULT_FRAME_INDEX;
    }
  }

  /**
   * Retrieves the thread display name
   *
   * @param thread Thread identifier
   * @return name
   */
  public getThreadDisplayName(thread: GdbThread): string {
    return thread.getDisplayName();
  }

  /**
   * Ask the frames count
   * @param thread Thread identifier
   */
  public async getFramesCount(thread: GdbThread): Promise<number> {
    if (thread.getThreadId() === GdbAmigaSysThreadId.CPU) {
      const message = "qTStatus";
      const data = await this.sendPacketString(message, GdbPacketType.QTSTATUS);
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
   * Retrieves the stack position for a frame
   *
   * @param thread Thread identifier
   * @param frameIndex Index of the frame selected
   */
  protected async getStackPosition(
    thread: GdbThread,
    frameIndex: number
  ): Promise<GdbStackPosition> {
    if (thread.getThreadId() === GdbAmigaSysThreadId.CPU) {
      // Get the current frame
      const [pc, index] = await this.getRegister("pc", frameIndex);
      if (pc) {
        const [segmentId, offset] = this.toRelativeOffset(pc);
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
    } else if (thread.getThreadId() === GdbAmigaSysThreadId.COP) {
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
    throw new Error(
      "No frames for thread: " + this.getThreadDisplayName(thread)
    );
  }

  /**
   * Gets the current stack frame
   *
   * @param thread Thread identifier
   */
  public async stack(thread: GdbThread): Promise<GdbStackPosition[]> {
    const unlock = await this.mutex.capture("stack");
    try {
      const stackPositions = new Array<GdbStackPosition>();
      // Retrieve the current frame
      let stackPosition = await this.getStackPosition(
        thread,
        GdbProxy.DEFAULT_FRAME_INDEX
      );
      stackPositions.push(stackPosition);
      if (thread.getThreadId() === GdbAmigaSysThreadId.CPU) {
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
   * Send a stop on step event for thread
   * @param thread selected thread
   */
  private sendStopOnStepEvent(thread: GdbThread) {
    for (const thId of this.threads.keys()) {
      if (thId !== thread.getId()) {
        this.sendEvent("stopOnStep", thId, true);
      }
    }
    this.sendEvent("stopOnStep", thread.getId(), false);
  }

  /**
   * Ask the debugger to step until the pc is in range
   * @param thread Thread selected
   * @param startAddress Start address for the stop range included
   * @param endAddress Start address for the stop range excluded
   */
  public async stepToRange(
    thread: GdbThread,
    startAddress: number,
    endAddress: number
  ): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      // TODO: Remove hack to step over... Put real addresses
      message =
        "vCont;r" +
        GdbProxy.formatNumber(startAddress) +
        "," +
        GdbProxy.formatNumber(endAddress) +
        ":" +
        thread.marshall();
    } else {
      // Not a real GDB command...
      message = "n";
    }
    thread.setState(GdbThreadState.STEPPING);
    await this.sendPacketString(message, GdbPacketType.STOP);
    this.sendStopOnStepEvent(thread);
  }

  /**
   * Ask the debugger to step in
   * @param thread Thread selected
   */
  public async stepIn(thread: GdbThread): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      message = "vCont;s:" + thread.marshall();
    } else {
      message = "s";
    }
    thread.setState(GdbThreadState.STEPPING);
    await this.sendPacketString(message, GdbPacketType.STOP);
    this.sendStopOnStepEvent(thread);
  }

  /**
   * Retrieve the details of the status register
   * @param srValue Status Register value
   */
  public static getSRDetailedValues(srValue: number): GdbRegister[] {
    const registers: GdbRegister[] = [];
    let intMask = 0;
    let intPos = 2;
    for (let i = 0; i < GdbProxy.SR_LABELS.length; i++) {
      const label = GdbProxy.SR_LABELS[i];
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

  /**
   * Retrieves all the register values
   */
  public async registers(
    frameId: number | null,
    thread?: GdbThread | null
  ): Promise<Array<GdbRegister>> {
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
      const message = await this.sendPacketString(
        command,
        GdbPacketType.UNKNOWN
      );
      let registers = new Array<GdbRegister>();
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
      registers = registers.concat(GdbProxy.getSRDetailedValues(sr));
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
      "m" +
        GdbProxy.formatNumber(address) +
        "," +
        GdbProxy.formatNumber(length),
      GdbPacketType.UNKNOWN
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
      "M" + GdbProxy.formatNumber(address) + "," + size + ":" + dataToSend,
      GdbPacketType.OK
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
    let returnedFrameIndex = GdbProxy.DEFAULT_FRAME_INDEX;
    try {
      // the current frame
      if (frameIndex !== undefined) {
        const sReturnedFrameIndex = await this.selectFrame(frameIndex, null);
        if (sReturnedFrameIndex !== undefined) {
          returnedFrameIndex = sReturnedFrameIndex;
        }
        if (
          frameIndex !== GdbProxy.DEFAULT_FRAME_INDEX &&
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
          "p" + GdbProxy.formatNumber(regIdx),
          GdbPacketType.UNKNOWN
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
   * Parses a threads response
   * @param threadsMessage Message containing the threads
   * @returns array of threads
   */
  public parseThreadsMessage(threadsMessage: string): GdbThread[] {
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
    const returnedThreads: GdbThread[] = [];
    for (const elm of pData.split(",")) {
      const th = GdbThread.parse(elm);
      returnedThreads.push(th);
      this.threads.set(th.getId(), th);
      this.threadsNative.set(elm, th);
    }
    return returnedThreads;
  }

  /**
   * Reads the thread id's
   */
  public async getThreadIds(): Promise<GdbThread[]> {
    const unlock = await this.mutex.capture("getThreadIds");
    try {
      if (this.threads.size <= 0) {
        const data = await this.sendPacketString(
          "qfThreadInfo",
          GdbPacketType.UNKNOWN
        );
        return this.parseThreadsMessage(data);
      } else {
        return Array.from(this.threads.values());
      }
    } finally {
      unlock();
    }
  }

  public on<U extends keyof GdbEvents>(event: U, listener: GdbEvents[U]): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  public once<U extends keyof GdbEvents>(
    event: U,
    listener: GdbEvents[U]
  ): this {
    this.eventEmitter.once(event, listener);
    return this;
  }

  public off<U extends keyof GdbEvents>(
    event: U,
    listener: GdbEvents[U]
  ): this {
    this.eventEmitter.off(event, listener);
    return this;
  }

  /**
   * Sends an event
   * @param event Event to send
   * @param args Arguments
   */
  protected sendEvent<U extends keyof GdbEvents>(
    event: U,
    ...args: Parameters<GdbEvents[U]>
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
  protected parseSegments(segmentReply: string): void {
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

  protected async parseStop(message: string): Promise<void> {
    const haltStatus = this.parseHaltStatus(message);
    const currentCpuThread = this.getCurrentCpuThread();
    let currentThreadId = -1;
    if (haltStatus.thread) {
      currentThreadId = haltStatus.thread.getId();
    } else if (currentCpuThread) {
      currentThreadId = currentCpuThread.getId();
    }
    switch (haltStatus.code) {
      case GdbSignal.TRAP: // Trace/breakpoint trap
        // A breakpoint has been reached
        if (this.stopOnEntryRequested) {
          this.stopOnEntryRequested = false;
          this.sendEvent("stopOnEntry", currentThreadId);
        } else {
          this.sendEvent("stopOnBreakpoint", currentThreadId);
        }
        break;
      case GdbSignal.EMT: // Emulation trap -> copper breakpoint
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
  ): [GdbThread | undefined, Map<number, number>] {
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
  protected parseHaltStatus(message: string): GdbHaltStatus {
    // Retrieve the cause
    const sig = parseInt(message.substring(1, 3), 16);
    let parameters: string | null = null;
    if (message.length > 3) {
      parameters = message.substring(3);
    }
    let details = "";
    switch (sig) {
      case GdbSignal.INT: // Interrupt
        details = "Interrupt";
        break;
      case GdbSignal.ILL: // Illegal instruction
        details = "Illegal instruction";
        break;
      case GdbSignal.TRAP: // Trace/breakpoint trap
        details = "Trace/breakpoint trap";
        break;
      case GdbSignal.EMT: // Emulation trap
        details = "Emulation trap";
        break;
      case GdbSignal.FPE: // Arithmetic exception
        details = "Arithmetic exception";
        break;
      case GdbSignal.BUS: // Bus error
        details = "Bus error";
        break;
      case GdbSignal.SEGV: // Segmentation fault
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
      const pc = registersMap.get(GdbProxy.REGISTER_PC_INDEX);
      if (pc) {
        posString = " in $" + GdbProxy.formatNumber(pc);
      }
      if (thread) {
        posString += " thread: " + this.getThreadDisplayName(thread);
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
   * Ask for the status of the current stop
   */
  public async getHaltStatus(): Promise<GdbHaltStatus[]> {
    const returnedHaltStatus = new Array<GdbHaltStatus>();
    const response = await this.sendPacketString("?", GdbPacketType.STOP);
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
  public async pause(thread: GdbThread): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      message = "vCont;t:" + thread.marshall();
    } else {
      // Not a real GDB command...
      message = "vCtrlC";
    }
    thread.setState(GdbThreadState.STEPPING);
    await this.sendPacketString(message, GdbPacketType.STOP);
    this.sendEvent("stopOnPause", thread.getId());
  }

  /**
   * Continue the execution
   */
  public async continueExecution(thread: GdbThread): Promise<void> {
    let message: string;
    if (this.supportVCont) {
      message = "vCont;c:" + thread.marshall();
    } else {
      // Not a real GDB command...
      message = "c";
    }
    thread.setState(GdbThreadState.RUNNING);
    await this.sendPacketString(message, null, false);
    this.sendEvent("continueThread", thread.getId(), true);
  }

  /**
   * Gets the register index from it's name
   */
  public getRegisterIndex(name: string): number | null {
    if (name.length > 1) {
      const type = name.charAt(0);
      const idx = parseInt(name.charAt(1));
      if (type === "d") {
        return idx + GdbProxy.REGISTER_D0_INDEX;
      } else if (type === "a") {
        return idx + GdbProxy.REGISTER_A0_INDEX;
      } else if (name === "pc") {
        return GdbProxy.REGISTER_PC_INDEX;
      } else if (name === "sr") {
        return GdbProxy.REGISTER_SR_INDEX;
      } else if (name === "copper") {
        return GdbProxy.REGISTER_COPPER_ADDR_INDEX;
      }
    }
    return null;
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
  public getThread(gdbThreadId: number): GdbThread | undefined {
    return this.threads.get(gdbThreadId);
  }

  /**
   * Returns the thread with an amiga sys type
   */
  public getThreadFromSysThreadId(
    sysThreadId: GdbAmigaSysThreadId
  ): GdbThread | undefined {
    for (const t of this.threads.values()) {
      if (t.getThreadId() === sysThreadId) {
        return t;
      }
    }
    return undefined;
  }

  /**
   * Returns the current CPU thread...
   */
  public getCurrentCpuThread(): GdbThread | undefined {
    return this.getThreadFromSysThreadId(GdbAmigaSysThreadId.CPU);
  }

  /**
   * Checks if it is a CPU thread
   * @param thread Thread to test
   * @return true if it is a CPU thread
   */
  public isCPUThread(thread: GdbThread): boolean {
    return thread.getThreadId() === GdbAmigaSysThreadId.CPU;
  }

  /**
   * Checks if it is a copper thread
   * @param thread Thread to test
   * @return true if it is a copper thread
   */
  public isCopperThread(thread: GdbThread): boolean {
    return thread.getThreadId() === GdbAmigaSysThreadId.COP;
  }

  /**
   * Returns the current array of segments
   * @return array of segments or undefined
   */
  public getSegments(): GdbSegment[] | undefined {
    return this.segments;
  }

  /**
   * Adds a segment retrieved from the hunk file
   * @param segment Segment to add
   * @return the start address of the segment
   */
  public addSegment(segment: GdbSegment): number {
    if (this.segments) {
      const lastSegment = this.segments[this.segments.length - 1];
      segment.address = lastSegment.address + lastSegment.size;
      this.segments.push(segment);
      return segment.size;
    }
    return -1;
  }

  /**
   * Parsing an error message
   * @param message Error message
   */
  protected parseError(message: string): GdbError {
    const error = new GdbError(message);
    this.sendEvent("error", error);
    return error;
  }

  /**
   * Transforms an absolute offset to a segmentsId and local offset
   * @param offset Absolute offset
   * @return Array with segmentId and a local offset
   */
  public toRelativeOffset(offset: number): [number, number] {
    if (this.segments) {
      let segmentId = 0;
      for (const segment of this.segments) {
        if (
          offset >= segment.address &&
          offset <= segment.address + segment.size
        ) {
          return [segmentId, offset - segment.address];
        }
        segmentId++;
      }
    }
    return [-1, offset];
  }

  /**
   * Transforms an offset in local segment coordinated to an absolute offset
   */
  public toAbsoluteOffset(segmentId: number, offset: number): number {
    if (this.segments) {
      if (segmentId < this.segments.length) {
        return this.segments[segmentId].address + offset;
      }
    }
    return offset;
  }

  /**
   * Formats a number to send
   * @param n number
   */
  protected static formatNumber(n: number): string {
    if (n === 0) {
      return "0";
    }
    return n.toString(16);
  }
}

export class GdbError extends Error {
  public errorType: string;
  constructor(errorType: string) {
    super();
    this.errorType = errorType.toUpperCase();
    this.name = "GdbError";
    this.createMessage();
  }
  private createMessage() {
    switch (this.errorType) {
      case "E01":
        this.message = "General error during processing";
        break;
      case "E02":
        this.message = "Error during the packet parse";
        break;
      case "E03":
        this.message = "Unsupported / unknown command";
        break;
      case "E04":
        this.message = "Unknown register";
        break;
      case "E05":
        this.message = "Invalid Frame Id";
        break;
      case "E06":
        this.message = "Invalid memory location";
        break;
      case "E07":
        this.message = "Address not safe for a set memory command";
        break;
      case "E08":
        this.message = "Unknown breakpoint";
        break;
      case "E09":
        this.message = "The maximum of breakpoints have been reached";
        break;
      case "E0F":
        this.message = "Error during the packet parse for command send memory";
        break;
      case "E10":
        this.message = "Unknown register";
        break;
      case "E11":
        this.message = "Invalid Frame Id";
        break;
      case "E12":
        this.message = "Invalid memory location";
        break;
      case "E20":
        this.message = "Error during the packet parse for command set memory";
        break;
      case "E21":
        this.message = "Missing end packet for a set memory message";
        break;
      case "E22":
        this.message = "Address not safe for a set memory command";
        break;
      case "E25":
        this.message = "Error during the packet parse for command set register";
        break;
      case "E26":
        this.message = "Error during set register - unsupported register name";
        break;
      case "E30":
        this.message = "Error during the packet parse for command get register";
        break;
      case "E31":
        this.message = "Error during the vCont packet parse";
        break;
      case "E40":
        this.message = "Unable to load segments";
        break;
      case "E41":
        this.message = "Thread command parse error";
        break;
      default:
        this.message = "Error code received: '" + this.errorType + "'";
        break;
    }
  }
}

export function breakpointToString(bp: GdbBreakpoint): string {
  let out = "";
  if (isSourceBreakpoint(bp)) {
    out = `Source Breakpoint #${bp.id} ${bp.source.name}:${bp.line} ${bp.segmentId}/${bp.offset}`;
  } else if (isExceptionBreakpoint(bp)) {
    out = `Exception Breakpoint: #${bp.id} ${bp.exceptionMask}`;
  } else if (isDataBreakpoint(bp)) {
    out = `Data Breakpoint #${bp.id} ${bp.offset} ${bp.size} (${bp.accessType}`;
  } else if (isInstructionBreakpoint(bp)) {
    out = `Instruction Breakpoint #${bp.id} ${bp.offset}`;
  } else {
    out = `Breakpoint #${bp.id}`;
  }
  if (bp.condition) {
    out += " condition: " + bp.condition;
  }
  if (bp.hitCondition) {
    out += " hitCondition: " + bp.hitCondition;
  }
  return out;
}
