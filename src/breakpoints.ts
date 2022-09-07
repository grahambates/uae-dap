import { Mutex } from "./utils/mutex";
import { DebugProtocol } from "@vscode/debugprotocol";
import { BreakpointCode, GdbClient } from "./gdbClient";
import { isDisassembledFile } from "./disassembly";
import { normalize } from "./utils/files";
import { logger, Source } from "@vscode/debugadapter";
import SourceMap from "./sourceMap";
import { formatAddress } from "./utils/strings";

export interface Breakpoint extends DebugProtocol.Breakpoint {
  type: BreakpointType;
  condition?: string;
  hitCondition?: string;
  hitCount: number;
  logMessage?: string;
  size?: number;
  accessType?: DebugProtocol.DataBreakpointAccessType;
  temporary?: boolean;
}

export enum BreakpointType {
  SOURCE,
  DATA,
  INSTRUCTION,
  TEMPORARY,
}

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

export interface SourceBreakpointReference {
  breakpoint: DebugProtocol.SourceBreakpoint;
  address: number;
  hitCount: number;
}

/**
 * Breakpoint manager
 *
 * Handles adding and removing breakpoints to program
 */
export class BreakpointManager {
  /** Breakpoints selected */
  private breakpoints: Breakpoint[] = [];
  /** Next breakpoint id - used to assign unique IDs to created breakpoints */
  private nextBreakpointId = 0;
  /** Temporary breakpoints arrays */
  private temporaryBreakpointArrays: Breakpoint[][] = [];
  /** Mutex to just have one call to gdb */
  protected mutex = new Mutex(100, 180000);
  /** Lock for breakpoint management function */
  protected breakpointLock?: () => void;

  protected sourceBreakpoints = new Map<
    string,
    Map<number, SourceBreakpointReference>
  >();

  protected sourceBreakpointsByAddress = new Map<
    number,
    SourceBreakpointReference
  >();

  private sourceMap?: SourceMap;

  public constructor(private gdb: GdbClient) {}

  /**
   * Set source map
   */
  public setSourceMap(sourceMap: SourceMap): BreakpointManager {
    this.sourceMap = sourceMap;
    return this;
  }

  public async setSourceBreakpoints(
    source: DebugProtocol.Source,
    breakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    const key = source.path || source.sourceReference?.toString();
    if (!key) {
      throw new Error("Invalid source");
    }

    const existing = this.sourceBreakpoints.get(key);
    if (existing) {
      logger.log("Removing existing breakpoints for source " + key);
      for (const { address } of existing.values()) {
        this.sourceBreakpointsByAddress.delete(address);
        await this.gdb.removeBreakpoint(address);
      }
    }

    const outBreakpoints: DebugProtocol.Breakpoint[] = [];
    const newRefs = new Map<number, SourceBreakpointReference>();

    for (const bp of breakpoints) {
      const outBp: DebugProtocol.Breakpoint = {
        ...bp,
        verified: false,
      };
      try {
        if (!this.sourceMap) {
          throw new Error("Program not loaded");
        }
        if (source.path) {
          const location = this.sourceMap.lookupSourceLine(
            source.path,
            bp.line
          );
          logger.log(`Source breakoint at ${JSON.stringify(location)}`);
          await this.gdb.setBreakpoint(location.address);
          const ref: SourceBreakpointReference = {
            address: location.address,
            breakpoint: bp,
            hitCount: 0,
          };
          newRefs.set(bp.line, ref);
          this.sourceBreakpointsByAddress.set(location.address, ref);
        } else if (source.sourceReference) {
          // TODO
        }
        outBp.verified = true;
      } catch (err) {
        if (err instanceof Error) outBp.message = err.message;
      }
      outBreakpoints.push(outBp);
    }

    this.sourceBreakpoints.set(key, newRefs);

    return outBreakpoints;
  }

  public sourceBreakpointAtAddress(
    address: number
  ): SourceBreakpointReference | undefined {
    return this.sourceBreakpointsByAddress.get(address);
  }

  /**
   * Set breakpoint
   *
   * Breakpoint will be sent to the program if ready and can be resolved, otherwise added to pending array.
   *
   * @returns Added immediately?
   */
  public async setBreakpoint(bp: Breakpoint): Promise<void> {
    if (!this.sourceMap) {
      throw new Error("Program not loaded");
    }
    // Resolve source location
    if (bp.source && bp.line !== undefined) {
      const path = bp.source.path ?? "";
      const location = this.sourceMap.lookupSourceLine(path, bp.line);
      bp.offset = location.address;
      await this.gdb.setBreakpoint(location.address, BreakpointCode.SOFTWARE);
    } else if (bp.accessType && bp.offset) {
      const type = bp.accessType
        ? accessTypeMap[bp.accessType]
        : BreakpointCode.ACCESS;
      await this.gdb.setBreakpoint(bp.offset, type, bp.size);
    } else {
      throw new Error("Unsupported breakpoint");
    }

    bp.verified = true;
    logger.log(`[BP] Set ${breakpointToString(bp)}`);

    this.breakpoints.push(bp);
  }

  // Breakpoint factories:

  /**
   * Create a new source breakpoint object
   */
  public createBreakpoint(
    source: DebugProtocol.Source,
    reqBp: DebugProtocol.SourceBreakpoint
  ): Breakpoint {
    return {
      ...reqBp,
      id: this.nextBreakpointId++,
      type: BreakpointType.SOURCE,
      source,
      verified: false,
      offset: 0,
      hitCount: 0,
    };
  }

  /**
   * Create a new temporary breakpoint object
   */
  public createTemporaryBreakpoint(address: number): Breakpoint {
    return {
      id: this.nextBreakpointId++,
      type: BreakpointType.TEMPORARY,
      offset: address,
      verified: false,
      hitCount: 0,
      temporary: true,
    };
  }

  /**
   * Create a new instruction breakpoint object
   */
  public createInstructionBreakpoint(address: number): Breakpoint {
    return {
      id: this.nextBreakpointId++,
      type: BreakpointType.INSTRUCTION,
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
  ): Breakpoint {
    return {
      id: this.nextBreakpointId++,
      type: BreakpointType.DATA,
      offset,
      verified: false,
      size,
      accessType,
      message,
      hitCount: 0,
    };
  }

  /**
   * Ask to remove a breakpoint
   */
  public async removeBreakpoint(breakpoint: Breakpoint): Promise<void> {
    logger.log(`[BP] Removing breakpoint #${breakpoint.id}`);
    await this.acquireLock();
    try {
      if (breakpoint.offset) {
        await this.gdb.removeBreakpoint(breakpoint.offset);
      }
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
    logger.log(`[BP] Clearing source breakpoints (source: ${source.name})`);
    return this.clearBreakpointsType(BreakpointType.SOURCE, source);
  }

  /**
   * Clear data breakpoints
   */
  public clearDataBreakpoints(): Promise<void> {
    logger.log(`[BP] Clearing data breakpoints`);
    return this.clearBreakpointsType(BreakpointType.DATA);
  }

  /**
   * Clear instruction breakpoints
   */
  public clearInstructionBreakpoints(): Promise<void> {
    logger.log(`[BP] Clearing instruction breakpoints`);
    return this.clearBreakpointsType(BreakpointType.INSTRUCTION);
  }

  private async clearBreakpointsType(
    type: BreakpointType,
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
          if (bp.offset) {
            await this.gdb.removeBreakpoint(bp.offset);
          }
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

  // Temporary breakpoints

  public async addTemporaryBreakpointArray(
    tmpBreakpoints: Breakpoint[]
  ): Promise<void> {
    this.temporaryBreakpointArrays.push(tmpBreakpoints);
    for (const bp of tmpBreakpoints) {
      if (bp.offset) {
        await this.gdb.setBreakpoint(bp.offset);
      }
    }
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
    tmpBreakpoints: Breakpoint[]
  ): Promise<void> {
    try {
      await this.acquireLock();
      for (const bp of tmpBreakpoints) {
        if (bp.offset) {
          await this.gdb.removeBreakpoint(bp.offset);
        }
      }
      this.temporaryBreakpointArrays = this.temporaryBreakpointArrays.filter(
        (item) => item !== tmpBreakpoints
      );
    } finally {
      this.releaseLock();
    }
  }

  public createTemporaryBreakpointArray(offsets: Array<number>): Breakpoint[] {
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

/**
 * Format as string for logging
 */
export function breakpointToString(bp: Breakpoint): string {
  let out = "";
  switch (bp.type) {
    case BreakpointType.SOURCE:
      out = `Source Breakpoint #${bp.id} ${bp.source?.name}:${bp.line}`;
      break;
    case BreakpointType.DATA:
      out = `Data Breakpoint #${bp.id} size: ${bp.size} accessType: ${bp.accessType}`;
      break;
    case BreakpointType.INSTRUCTION:
      out = `Instruction Breakpoint #${bp.id}`;
      break;
    case BreakpointType.TEMPORARY:
      out = `Instruction Breakpoint #${bp.id}`;
      break;
  }
  if (bp.offset) {
    out += ` at ${formatAddress(bp.offset)}`;
  }
  if (bp.condition) {
    out += " condition: " + bp.condition;
  }
  if (bp.hitCondition) {
    out += " hitCondition: " + bp.hitCondition;
  }
  return out;
}

const accessTypeMap: Record<
  DebugProtocol.DataBreakpointAccessType,
  BreakpointCode
> = {
  read: BreakpointCode.READ,
  write: BreakpointCode.WRITE,
  readWrite: BreakpointCode.ACCESS,
};
