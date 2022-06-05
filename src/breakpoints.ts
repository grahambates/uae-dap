import { Mutex } from "./utils/mutex";
import { DebugProtocol } from "@vscode/debugprotocol";
import {
  GdbProxy,
  GdbBreakpoint,
  GdbBreakpointType,
  GdbBreakpointAccessType,
  isSourceBreakpoint,
  isExceptionBreakpoint,
  GdbBreakpointException,
  GdbBreakpointData,
  GdbBreakpointInstruction,
  GdbBreakpointTemporary,
  isDataBreakpoint,
  isInstructionBreakpoint,
} from "./gdb";
import Program from "./program";
import { isDisassembledFile } from "./disassembly";
import { normalize } from "./utils/files";

export interface BreakpointStorage {
  getSize(id: string): number | undefined;
  setSize(id: string, size: number): void;
  clear(): void;
}

export class BreakpointStorageMap implements BreakpointStorage {
  private static map = new Map<string, number>();

  getSize(id: string): number | undefined {
    return BreakpointStorageMap.map.get(id);
  }
  setSize(id: string, size: number): void {
    BreakpointStorageMap.map.set(id, size);
  }
  clear(): void {
    BreakpointStorageMap.map = new Map<string, number>();
  }
}

/**
 * Breakpoint manager
 *
 * Handles adding and removing breakpoints to program
 */
export class BreakpointManager {
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
  /** Next breakpoint id - used to assign unique IDs to created breakpoints */
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

  // Setters:

  /**
   * Set exception mask
   */
  public setExceptionMask(exceptionMask: number): BreakpointManager {
    this.exceptionMask = exceptionMask;
    return this;
  }

  /**
   * Set program
   */
  public setProgram(program: Program): BreakpointManager {
    this.program = program;
    return this;
  }

  /**
   * Set the mutex timeout
   * @param timeout Mutex timeout
   */
  public setMutexTimeout(timeout: number): void {
    this.mutex = new Mutex(100, timeout);
  }

  /**
   * Set breakpoint
   *
   * Breakpoint will be sent to the program if ready and can be resolved, otherwise added to pending array.
   *
   * @returns Added immediately?
   */
  public async setBreakpoint(bp: GdbBreakpoint): Promise<boolean> {
    try {
      if (!this.gdbProxy.isConnected() || !this.program) {
        throw new Error();
      }
      // Resolve source location
      if (isSourceBreakpoint(bp)) {
        bp.verified = false;
        const path = bp.source.path ?? "";

        if (isDisassembledFile(path)) {
          // Disassembly source
          bp.offset = await this.program.getAddressForFileEditorLine(
            bp.source.name ?? "",
            bp.line
          );
          bp.segmentId = undefined;
        } else {
          // Regular source
          const location = await this.program.findLocationForLine(
            path,
            bp.line
          );
          if (!location) {
            throw new Error("Segment offset not resolved");
          }
          bp.segmentId = location.segmentId;
          bp.offset = location.offset;
        }
      } else if (
        !isExceptionBreakpoint(bp) &&
        !isDataBreakpoint(bp) &&
        !isInstructionBreakpoint(bp)
      ) {
        throw new Error("Breakpoint info incomplete");
      }

      await this.gdbProxy.setBreakpoint(bp);
      if (!isExceptionBreakpoint(bp)) {
        this.breakpoints.push(bp);
      }
      return true;
    } catch (error) {
      // Add as pending if any error encountered
      this.addPendingBreakpoint(bp, error instanceof Error ? error : undefined);
      return false;
    }
  }

  // Pending breakpoints:
  // If a breakpoint can't be added to the program yet e.g. because the program hasn't started or the breakpoint can't
  // be resolved, it's added to an array to be sent later.

  /**
   * Add a breakpoint to be sent when the program is ready
   *
   * @param breakpoint Breakpoint to add
   * @param err Error the prevented the breakpoint being added immediately
   */
  public addPendingBreakpoint(breakpoint: GdbBreakpoint, err?: Error): void {
    breakpoint.verified = false;
    if (err) {
      breakpoint.message = err.message;
    }
    this.pendingBreakpoints.push(breakpoint);
  }

  /**
   * Find the breakpoint corresponding to a source line
   */
  public findSourceBreakpoint(source?: DebugProtocol.Source, line?: number) {
    return this.breakpoints.find(
      (bp) =>
        bp.source &&
        source &&
        this.isSameSource(bp.source, source) &&
        bp.line === line
    );
  }

  /**
   * Get pending breakpoints array
   */
  public getPendingBreakpoints(): GdbBreakpoint[] {
    return this.pendingBreakpoints;
  }

  /**
   * Add segment and offset to pending breakpoints
   */
  public async addLocationToPending(): Promise<void> {
    if (!this.program) {
      return;
    }
    for (const bp of this.pendingBreakpoints) {
      if (bp.source && bp.line) {
        const path = bp.source.path ?? "";
        if (!isDisassembledFile(path)) {
          await this.addLocation(bp, path, bp.line);
        }
      }
    }
  }

  /**
   * Send pending breakpoints to program
   */
  public sendAllPendingBreakpoints = async (): Promise<void> => {
    if (this.pendingBreakpoints.length > 0) {
      await this.acquireLock();
      const pending = this.pendingBreakpoints;
      this.pendingBreakpoints = [];
      await Promise.all(pending.map((bp) => this.setBreakpoint(bp)));
      this.releaseLock();
    }
  };

  // Breakpoint factories:

  /**
   * Create a new source breakpoint object
   */
  public createBreakpoint(
    source: DebugProtocol.Source,
    reqBp: DebugProtocol.SourceBreakpoint
  ): GdbBreakpoint {
    return {
      ...reqBp,
      type: GdbBreakpointType.SOURCE,
      id: this.nextBreakpointId++,
      source,
      verified: false,
      offset: 0,
      hitCount: 0,
    };
  }

  /**
   * Create a new temporary breakpoint object
   */
  public createTemporaryBreakpoint(address: number): GdbBreakpointTemporary {
    return {
      type: GdbBreakpointType.TEMPORARY,
      id: this.nextBreakpointId++,
      offset: address,
      verified: false,
      hitCount: 0,
    };
  }

  /**
   * Create a new instruction breakpoint object
   */
  public createInstructionBreakpoint(
    address: number
  ): GdbBreakpointInstruction {
    return {
      type: GdbBreakpointType.INSTRUCTION,
      id: this.nextBreakpointId++,
      offset: address,
      verified: false,
      hitCount: 0,
    };
  }

  /**
   * Create a new data breakpoint object
   */
  public createDataBreakpoint(
    offset: number,
    size: number,
    accessType: DebugProtocol.DataBreakpointAccessType = "readWrite",
    message?: string
  ): GdbBreakpointData {
    return {
      type: GdbBreakpointType.DATA,
      id: this.nextBreakpointId++,
      offset,
      verified: false,
      size,
      accessType: accessTypes[accessType],
      message,
      defaultMessage: message,
      dataId: "",
      hitCount: 0,
    };
  }

  public createExceptionBreakpoint(): GdbBreakpointException {
    return {
      type: GdbBreakpointType.EXCEPTION,
      id: this.nextBreakpointId++,
      exceptionMask: this.exceptionMask,
      verified: false,
      offset: 0,
      hitCount: 0,
    };
  }

  // Exception breakpoints:

  /**
   * Ask for an exception breakpoint
   */
  public setExceptionBreakpoint(): Promise<boolean> {
    const breakpoint = this.createExceptionBreakpoint();
    return this.setBreakpoint(breakpoint);
  }

  /**
   * Ask to remove an exception breakpoint
   */
  public async removeExceptionBreakpoint(): Promise<void> {
    await this.acquireLock();
    const breakpoint = this.createExceptionBreakpoint();
    try {
      await this.gdbProxy.removeBreakpoint(breakpoint);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Ask to remove a breakpoint
   */
  public async removeBreakpoint(breakpoint: GdbBreakpoint): Promise<void> {
    await this.acquireLock();
    try {
      await this.gdbProxy.removeBreakpoint(breakpoint);
      this.breakpoints = this.breakpoints.filter(
        (bp) => bp.id !== breakpoint.id
      );
    } finally {
      this.releaseLock();
    }
  }

  // Clearing breakpoints:

  /**
   * Clear source breakpoints
   */
  public clearBreakpoints(source: DebugProtocol.Source): Promise<void> {
    return this.clearBreakpointsType(GdbBreakpointType.SOURCE, source);
  }

  /**
   * Clear data breakpoints
   */
  public clearDataBreakpoints(): Promise<void> {
    return this.clearBreakpointsType(GdbBreakpointType.DATA);
  }

  /**
   * Clear instruction breakpoints
   */
  public clearInstructionBreakpoints(): Promise<void> {
    return this.clearBreakpointsType(GdbBreakpointType.INSTRUCTION);
  }

  private async clearBreakpointsType(
    type: GdbBreakpointType,
    source?: DebugProtocol.Source
  ): Promise<void> {
    let hasError = false;
    const remainingBreakpoints = [];
    await this.acquireLock();

    for (const bp of this.breakpoints) {
      const isCorrectType = bp.type === type;
      const isSameSource =
        source && bp.source && this.isSameSource(bp.source, source);

      if (isCorrectType && (!source || isSameSource)) {
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

    this.releaseLock();
    if (hasError) {
      throw new Error("Some breakpoints cannot be removed");
    }
  }

  // Temporary breakpoints (used for WinUAE):

  public async addTemporaryBreakpointArray(
    tmpBreakpoints: GdbBreakpoint[]
  ): Promise<void> {
    this.temporaryBreakpointArrays.push(tmpBreakpoints);
    await Promise.all(
      tmpBreakpoints.map((bp) => this.gdbProxy.setBreakpoint(bp))
    );
  }

  /**
   * Remove temporary breakpoints which contain PC address
   */
  public async checkTemporaryBreakpoints(pc: number): Promise<void> {
    await Promise.all(
      this.temporaryBreakpointArrays
        .filter((bps) => bps.some((bp) => bp.offset === pc))
        .map((bps) => this.removeTemporaryBreakpointArray(bps))
    );
  }

  public async removeTemporaryBreakpointArray(
    tmpBreakpoints: GdbBreakpoint[]
  ): Promise<void> {
    try {
      await this.acquireLock();
      await Promise.all(
        tmpBreakpoints.map((bp) => this.gdbProxy.removeBreakpoint(bp))
      );
      this.temporaryBreakpointArrays = this.temporaryBreakpointArrays.filter(
        (item) => item !== tmpBreakpoints
      );
    } finally {
      this.releaseLock();
    }
  }

  public createTemporaryBreakpointArray(
    offsets: Array<number>
  ): GdbBreakpoint[] {
    return offsets.map((o) => this.createTemporaryBreakpoint(o));
  }

  // Utils:

  private isSameSource(
    source: DebugProtocol.Source,
    other: DebugProtocol.Source
  ): boolean {
    return (
      (source.path !== undefined &&
        other.path !== undefined &&
        normalize(source.path) === normalize(other.path)) ||
      (source.name !== undefined &&
        isDisassembledFile(source.name) &&
        source.name === other.name)
    );
  }

  /**
   * Adds segmentId and offset properties to a breakpoint
   *
   * @return successfully added location?
   */
  private async addLocation(
    breakpoint: GdbBreakpoint,
    path: string,
    line: number
  ): Promise<boolean> {
    if (this.program) {
      const location = await this.program.findLocationForLine(path, line);
      if (location) {
        breakpoint.segmentId = location.segmentId;
        breakpoint.offset = location.offset;
        return true;
      }
    }
    return false;
  }

  private async acquireLock() {
    this.breakpointLock = await this.mutex.capture("breakpointLock");
  }

  private releaseLock() {
    if (this.breakpointLock) {
      this.breakpointLock();
      this.breakpointLock = undefined;
    }
  }
}

const accessTypes: Record<
  DebugProtocol.DataBreakpointAccessType,
  GdbBreakpointAccessType
> = {
  read: GdbBreakpointAccessType.READ,
  write: GdbBreakpointAccessType.WRITE,
  readWrite: GdbBreakpointAccessType.READWRITE,
};
