import { Mutex } from "./utils/mutex";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Logger } from "@vscode/debugadapter";
import { DisassembledFile } from "./disassembly";
import {
  GdbProxy,
  GdbBreakpoint,
  GdbBreakpointType,
  GdbBreakpointAccessType,
} from "./gdb";
import Program from "./program";

export class BreakpointManager {
  /** Size map */
  private static sizes = new Map<string, number>();
  /** Default selection mask for exception : each bit is a exception code */
  static readonly DEFAULT_EXCEPTION_MASK = 0b111100;
  /** exception mask */
  private exceptionMask = BreakpointManager.DEFAULT_EXCEPTION_MASK;
  /** Breakpoints selected */
  private breakpoints: GdbBreakpoint[] = [];
  /** Pending breakpoint not yet sent to debugger */
  private pendingBreakpoints: GdbBreakpoint[] = [];
  /** Debug information for the loaded program */
  private program?: Program;
  /** Next breakpoint id */
  private nextBreakpointId = 0;
  /** Temporary breakpoints arrays */
  private temporaryBreakpointArrays: GdbBreakpoint[][] = [];
  /** Mutex to just have one call to gdb */
  protected mutex = new Mutex(100, 180000);
  /** Lock for breakpoint management function */
  protected breakpointLock?: () => void;

  public constructor(private gdbProxy: GdbProxy) {
    gdbProxy.onFirstStop(this.sendAllPendingBreakpoints);
  }

  public setExceptionMask(exceptionMask: number): void {
    this.exceptionMask = exceptionMask;
  }

  public setProgram(program: Program): void {
    this.program = program;
  }

  /**
   * Set the mutex timeout
   * @param timeout Mutex timeout
   */
  public setMutexTimeout(timeout: number): void {
    this.mutex = new Mutex(100, timeout);
  }

  public addPendingBreakpoint(breakpoint: GdbBreakpoint, err?: Error): void {
    breakpoint.verified = false;
    if (err) {
      breakpoint.message = err.message;
    }
    this.pendingBreakpoints.push(breakpoint);
  }

  private async fillBreakpointWithSegAddress(
    debugBp: GdbBreakpoint,
    path: string,
    line: number
  ): Promise<boolean> {
    if (this.program) {
      const location = await this.program.findLocationForLine(path, line);
      if (location) {
        debugBp.segmentId = location.segmentId;
        debugBp.offset = location.offset;
        return true;
      }
    }
    return false;
  }

  public async checkPendingBreakpointsAddresses(): Promise<void> {
    if (this.program) {
      for (const bp of this.pendingBreakpoints) {
        if (bp.source && bp.line) {
          const path = <string>bp.source.path;
          if (!DisassembledFile.isDebugAsmFile(path)) {
            await this.fillBreakpointWithSegAddress(bp, path, bp.line);
          }
        }
      }
    }
  }

  public async setBreakpoint(bp: GdbBreakpoint): Promise<GdbBreakpoint> {
    if (!this.gdbProxy.isConnected()) {
      this.addPendingBreakpoint(bp);
      return bp;
    }
    const isData = bp.breakpointType === GdbBreakpointType.DATA;
    const isInstruction = bp.breakpointType === GdbBreakpointType.INSTRUCTION;
    const hasMask = bp.exceptionMask !== undefined;

    try {
      if (bp.source && bp.line !== undefined && bp.id !== undefined) {
        bp.verified = false;
        const path = bp.source.path ?? "";

        if (!this.program) {
          throw new Error("Program is not running");
        }

        if (!DisassembledFile.isDebugAsmFile(path)) {
          if (await this.fillBreakpointWithSegAddress(bp, path, bp.line)) {
            await this.gdbProxy.setBreakpoint(bp);
            this.breakpoints.push(bp);
          } else {
            throw new Error("Segment offset not resolved");
          }
        } else {
          const name = <string>bp.source.name;
          const address = await this.program.getAddressForFileEditorLine(
            name,
            bp.line
          );
          bp.segmentId = undefined;
          bp.offset = address;
          await this.gdbProxy.setBreakpoint(bp);
          this.breakpoints.push(bp);
        }
      } else if (hasMask || isData || isInstruction) {
        await this.gdbProxy.setBreakpoint(bp);
        if (!hasMask) {
          this.breakpoints.push(bp);
        }
      } else {
        throw new Error("Breakpoint info incomplete");
      }
    } catch (error) {
      this.addPendingBreakpoint(bp, error instanceof Error ? error : undefined);
      throw error;
    }
    return bp;
  }

  public createBreakpoint(
    source: DebugProtocol.Source,
    line: number
  ): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.SOURCE,
      id: this.nextBreakpointId++,
      line: line,
      source: source,
      verified: false,
      offset: 0,
    };
  }

  public createTemporaryBreakpoint(address: number): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.TEMPORARY,
      id: this.nextBreakpointId++,
      segmentId: undefined,
      offset: address,
      temporary: true,
      verified: false,
    };
  }

  public createInstructionBreakpoint(address: number): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.INSTRUCTION,
      id: this.nextBreakpointId++,
      segmentId: undefined,
      offset: address,
      temporary: false,
      verified: false,
    };
  }

  public createDataBreakpoint(
    address: number,
    size: number,
    accessType: string | undefined,
    message: string | undefined
  ): GdbBreakpoint {
    let gdbAccessType: GdbBreakpointAccessType;
    switch (accessType) {
      case GdbBreakpointAccessType.READ:
        gdbAccessType = GdbBreakpointAccessType.READ;
        break;
      case GdbBreakpointAccessType.WRITE:
        gdbAccessType = GdbBreakpointAccessType.WRITE;
        break;
      case GdbBreakpointAccessType.READWRITE:
        gdbAccessType = GdbBreakpointAccessType.READWRITE;
        break;
      default:
        gdbAccessType = GdbBreakpointAccessType.READWRITE;
        break;
    }
    return {
      breakpointType: GdbBreakpointType.DATA,
      id: this.nextBreakpointId++,
      segmentId: undefined,
      offset: address,
      verified: false,
      size: size,
      accessType: gdbAccessType,
      message: message,
      defaultMessage: message,
    };
  }

  public async addTemporaryBreakpointArray(
    temporaryBreakpointArray: GdbBreakpoint[]
  ): Promise<void> {
    this.temporaryBreakpointArrays.push(temporaryBreakpointArray);
    for (const debugBp of temporaryBreakpointArray) {
      await this.gdbProxy.setBreakpoint(debugBp);
    }
  }

  public async removeTemporaryBreakpointArray(
    temporaryBreakpointArray: GdbBreakpoint[]
  ): Promise<void> {
    try {
      this.breakpointLock = await this.mutex.capture("breakpointLock");
      for (const debugBp of temporaryBreakpointArray) {
        await this.gdbProxy.removeBreakpoint(debugBp);
      }
      this.temporaryBreakpointArrays = this.temporaryBreakpointArrays.filter(
        (item) => item !== temporaryBreakpointArray
      );
    } finally {
      if (this.breakpointLock) {
        this.breakpointLock();
        this.breakpointLock = undefined;
      }
    }
  }

  public createTemporaryBreakpointArray(
    offsets: Array<number>
  ): GdbBreakpoint[] {
    const tempArray: GdbBreakpoint[] = [];
    for (const addr of offsets) {
      const debugBp = this.createTemporaryBreakpoint(addr);
      tempArray.push(debugBp);
    }
    return tempArray;
  }

  public async checkTemporaryBreakpoints(pc: number): Promise<void> {
    const arraysToRemove: GdbBreakpoint[][] = [];
    for (const tempArray of this.temporaryBreakpointArrays) {
      for (const bp of tempArray) {
        if (bp.offset === pc) {
          arraysToRemove.push(tempArray);
        }
      }
    }
    for (const tempArray of arraysToRemove) {
      await this.removeTemporaryBreakpointArray(tempArray);
    }
  }

  public createExceptionBreakpoint(): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.EXCEPTION,
      id: this.nextBreakpointId++,
      exceptionMask: this.exceptionMask,
      verified: false,
      offset: 0,
    };
  }

  public sendAllPendingBreakpoints = async (): Promise<void> => {
    this.breakpointLock = await this.mutex.capture("breakpointLock");
    if (this.pendingBreakpoints && this.pendingBreakpoints.length > 0) {
      const pending = this.pendingBreakpoints;
      this.pendingBreakpoints = [];
      for (const bp of pending) {
        try {
          await this.setBreakpoint(bp);
        } catch (error) {
          //nothing to do - the breakpoint was already added to the pending list
        }
      }
    }
    if (this.breakpointLock) {
      this.breakpointLock();
      this.breakpointLock = undefined;
    }
  };

  /**
   * Ask for an exception breakpoint
   */
  public setExceptionBreakpoint(): Promise<GdbBreakpoint> {
    const breakpoint = this.createExceptionBreakpoint();
    return this.setBreakpoint(breakpoint);
  }

  /**
   * Ask to remove an exception breakpoint
   */
  public async removeExceptionBreakpoint(): Promise<void> {
    this.breakpointLock = await this.mutex.capture("breakpointLock");
    const breakpoint = this.createExceptionBreakpoint();
    try {
      await this.gdbProxy.removeBreakpoint(breakpoint);
    } finally {
      if (this.breakpointLock) {
        this.breakpointLock();
        this.breakpointLock = undefined;
      }
    }
  }

  private isSameSource(
    source: DebugProtocol.Source,
    other: DebugProtocol.Source
  ): boolean {
    const path = source.path;
    if (path) {
      return (
        source.path === other.path ||
        (DisassembledFile.isDebugAsmFile(path) && source.name === other.name)
      );
    }
    return source.path === other.path;
  }

  public async clearBreakpointsInner(
    source: DebugProtocol.Source | null,
    clearDataBreakpoint: boolean,
    clearInstructionBreakpoints: boolean
  ): Promise<void> {
    let hasError = false;
    const remainingBreakpoints = [];
    this.breakpointLock = await this.mutex.capture("breakpointLock");
    for (const bp of this.breakpoints) {
      if (
        (source &&
          bp.source &&
          this.isSameSource(bp.source, source) &&
          !clearDataBreakpoint &&
          !clearInstructionBreakpoints &&
          bp.breakpointType === GdbBreakpointType.SOURCE) ||
        (clearDataBreakpoint && bp.breakpointType === GdbBreakpointType.DATA) ||
        (clearInstructionBreakpoints &&
          bp.breakpointType === GdbBreakpointType.INSTRUCTION)
      ) {
        try {
          await this.gdbProxy.removeBreakpoint(bp);
        } catch (err) {
          remainingBreakpoints.push(bp);
          hasError = true;
        }
      } else {
        remainingBreakpoints.push(bp);
      }
    }
    this.breakpoints = remainingBreakpoints;
    if (this.breakpointLock) {
      this.breakpointLock();
      this.breakpointLock = undefined;
    }
    if (hasError) {
      throw new Error("Some breakpoints cannot be removed");
    }
  }
  public clearBreakpoints(source: DebugProtocol.Source): Promise<void> {
    return this.clearBreakpointsInner(source, false, false);
  }

  public clearDataBreakpoints(): Promise<void> {
    return this.clearBreakpointsInner(null, true, false);
  }

  public clearInstructionBreakpoints(): Promise<void> {
    return this.clearBreakpointsInner(null, false, true);
  }

  public getPendingBreakpoints(): GdbBreakpoint[] {
    return this.pendingBreakpoints;
  }

  public populateDataBreakpointInfoResponseBody(
    response: DebugProtocol.DataBreakpointInfoResponse,
    variableName: string,
    address: string,
    isRegister: boolean
  ) {
    let variableDisplay;
    if (isRegister) {
      variableDisplay = `${address}`;
    } else {
      variableDisplay = `${variableName}(${address})`;
    }
    response.body = {
      dataId: `${variableName}(${address})`,
      description: variableDisplay,
      accessTypes: ["read", "write", "readWrite"],
      canPersist: true,
    };
  }

  public parseDataIdAddress(dataId: string): [string, string, number] {
    const elements = dataId.split(/[()]/);
    if (elements.length > 1) {
      return [elements[0], elements[1], parseInt(elements[1])];
    } else {
      throw new Error("DataId format invalid");
    }
  }

  public static getSizeForDataBreakpoint(id: string): number | undefined {
    const size = BreakpointManager.sizes.get(id);
    Logger.logger.log(
      `[BreakpointManager] GET size of DataBreakpoint id: ${id}=${size}`
    );
    return size;
  }

  public static setSizeForDataBreakpoint(id: string, size: number) {
    Logger.logger.log(
      `[BreakpointManager] SET size of DataBreakpoint id: ${id}=${size}`
    );
    BreakpointManager.sizes.set(id, size);
  }

  public static removeSizeForDataBreakpoint(id: string) {
    Logger.logger.log(`[BreakpointManager] Removing DataBreakpoint id: ${id}`);
    BreakpointManager.sizes.delete(id);
  }
}
