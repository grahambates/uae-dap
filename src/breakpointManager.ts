import { DebugProtocol } from "@vscode/debugprotocol";
import { BreakpointCode, GdbClient } from "./gdbClient";
import { logger } from "@vscode/debugadapter";
import SourceMap from "./sourceMap";
import { formatAddress } from "./utils/strings";
import { DisassemblyManager, isDisassembledFile } from "./disassembly";

export interface BreakpointReference<
  T = DebugProtocol.SourceBreakpoint | DebugProtocol.DataBreakpoint
> {
  address: number;
  breakpoint: T;
  hitCount: number;
  size?: number;
}

/**
 * Interface for sizes map, which can be implemented with persistence for VS Code
 */
export interface DataBreakpointSizes {
  get(id: string): number | undefined;
  set(id: string, size: number): void;
  delete(id: string): void;
  clear(): void;
}

/**
 * Breakpoint manager
 *
 * Handles adding and removing breakpoints to program
 */
class BreakpointManager {
  /** Source breakpoints mapped by source and line number */
  private sourceBreakpoints = new Map<
    string,
    Map<number, BreakpointReference<DebugProtocol.SourceBreakpoint>>
  >();
  /** Source breakpoints mapped by address */
  private sourceBreakpointsByAddress = new Map<
    number,
    BreakpointReference<DebugProtocol.SourceBreakpoint>
  >();
  /** Data breakpoints mapped by address */
  private dataBreakpoints = new Map<
    number,
    BreakpointReference<DebugProtocol.DataBreakpoint>
  >();
  /** Instruction breakoint addresses */
  private instructionBreakpoints = new Set<number>();
  /** Temporary breakoint address groups */
  private temporaryBreakpoints = new Set<number>();

  private nextId = 0;

  public constructor(
    private gdb: GdbClient,
    private sourceMap: SourceMap,
    private disassembly: DisassemblyManager,
    private sizes: DataBreakpointSizes
  ) {}

  public async setSourceBreakpoints(
    source: DebugProtocol.Source,
    breakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    const sourceKey = source.path || source.sourceReference?.toString();
    if (!sourceKey) {
      throw new Error("Invalid source");
    }

    // Remove existing breakpoints for source
    const existing = this.sourceBreakpoints.get(sourceKey);
    if (existing) {
      logger.log("[BP] Removing existing breakpoints for source " + sourceKey);
      for (const { address } of existing.values()) {
        this.sourceBreakpointsByAddress.delete(address);
        await this.gdb.removeBreakpoint(address).catch(() => {
          logger.log("[BP] Error removing breakpoint at " + address);
        });
      }
    }

    // Add new breakpoints
    const outBreakpoints: DebugProtocol.Breakpoint[] = [];
    const newRefs = new Map<
      number,
      BreakpointReference<DebugProtocol.SourceBreakpoint>
    >();
    for (const bp of breakpoints) {
      const outBp: DebugProtocol.Breakpoint = {
        ...bp,
        verified: false,
      };
      try {
        if (!this.sourceMap) {
          throw new Error("Program not loaded");
        }
        if (!source.path) {
          throw new Error("Source has no path");
        }
        let address: number;
        if (isDisassembledFile(source.path)) {
          address = await this.disassembly.getAddressForFileEditorLine(
            source.name ?? "",
            bp.line
          );
        } else {
          const loc = this.sourceMap.lookupSourceLine(source.path, bp.line);
          logger.log(
            `Source breakoint at ${loc.path}:${loc.line} ${formatAddress(
              loc.address
            )}`
          );
          address = loc.address;
        }

        await this.gdb.setBreakpoint(address);
        const ref = {
          address,
          breakpoint: bp,
          hitCount: 0,
        };
        newRefs.set(bp.line, ref);
        this.sourceBreakpointsByAddress.set(address, ref);
        outBp.verified = true;
      } catch (err) {
        if (err instanceof Error) outBp.message = err.message;
      }
      outBreakpoints.push(outBp);
    }

    this.sourceBreakpoints.set(sourceKey, newRefs);

    return outBreakpoints;
  }

  public sourceBreakpointAtAddress(
    address: number
  ): BreakpointReference<DebugProtocol.SourceBreakpoint> | undefined {
    return this.sourceBreakpointsByAddress.get(address);
  }

  public async setDataBreakpoints(
    breakpoints: DebugProtocol.DataBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    const outBreakpoints: DebugProtocol.Breakpoint[] = [];

    const types = {
      read: BreakpointCode.READ,
      write: BreakpointCode.WRITE,
      readWrite: BreakpointCode.ACCESS,
    };

    const newIds = breakpoints.map((bp) => bp.dataId);

    // Clear existing data points:
    for (const [address, ref] of this.dataBreakpoints.entries()) {
      try {
        // If a breakpoint has actually been removed, delete the size for the map
        if (!newIds.includes(ref.breakpoint.dataId)) {
          logger.log(
            "[BP] removing size for breakpoint " + ref.breakpoint.dataId
          );
          this.sizes.delete(ref.breakpoint.dataId);
        }
        const { accessType } = ref.breakpoint;
        const type = accessType ? types[accessType] : BreakpointCode.ACCESS;
        await this.gdb.removeBreakpoint(address, type, ref.size);
      } catch (err) {
        logger.error((err as Error).message);
      }
    }
    this.dataBreakpoints.clear();

    // Process new data points:
    for (const i in breakpoints) {
      const bp = breakpoints[i];
      const outBp: DebugProtocol.Breakpoint = {
        id: this.nextId++,
        ...bp,
        verified: false,
      };
      outBreakpoints.push(outBp);
      try {
        const { address } = this.parseDataId(bp.dataId);
        const size = this.sizes.get(bp.dataId) || 2;
        outBp.message = `${size} bytes watched starting at ${formatAddress(
          address
        )}`;
        logger.log(`[BP] Data breakoint: ${outBp.message}`);

        this.dataBreakpoints.set(address, {
          breakpoint: bp,
          address,
          hitCount: 0,
          size,
        });

        const type = bp.accessType
          ? types[bp.accessType]
          : BreakpointCode.ACCESS;
        await this.gdb.setBreakpoint(address, type, size);

        outBp.verified = true;
      } catch (err) {
        if (err instanceof Error) outBp.message = err.message;
      }
    }
    return outBreakpoints;
  }

  public parseDataId(dataId: string): {
    name: string;
    displayValue: string;
    address: number;
  } {
    const match = dataId.match(/(?<name>.+)\((?<displayValue>.+)\)/);
    if (!match?.groups) {
      throw new Error("DataId format invalid");
    }
    const { name, displayValue } = match.groups;
    const address = parseInt(displayValue);
    return { name, displayValue, address };
  }

  public dataBreakpointAtAddress(
    address: number
  ): BreakpointReference<DebugProtocol.DataBreakpoint> | undefined {
    return this.dataBreakpoints.get(address);
  }

  public async setInstructionBreakpoints(
    breakpoints: DebugProtocol.InstructionBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    const outBreakpoints: DebugProtocol.Breakpoint[] = [];

    // Clear existing breakpoints:
    for (const address of this.instructionBreakpoints.values()) {
      await this.gdb.removeBreakpoint(address);
    }
    this.instructionBreakpoints.clear();

    // Process new breakpoints:
    for (const bp of breakpoints) {
      const outBp: DebugProtocol.Breakpoint = {
        ...bp,
        verified: false,
      };
      outBreakpoints.push(outBp);

      try {
        const address = parseInt(bp.instructionReference);
        logger.log(`[BP] Instruction Breakpoint at ${formatAddress(address)}`);

        // Set in GDB:
        await this.gdb.setBreakpoint(address);

        this.instructionBreakpoints.add(address);
        outBp.verified = true;
      } catch (err) {
        if (err instanceof Error) outBp.message = err.message;
      }
    }
    return outBreakpoints;
  }

  public instructionBreakpointAtAddress(address: number): boolean {
    return this.instructionBreakpoints.has(address);
  }

  // Temporary breakpoints:

  public async addTemporaryBreakpoints(pc: number): Promise<void> {
    await this.clearTemporaryBreakpoints();

    // Set breakpoints at three possible offsets from PC
    const tmpBreakpoints = [pc + 1, pc + 2, pc + 4];
    for (const offset of tmpBreakpoints) {
      logger.log(`[BP] Temporary Breakpoint at ${formatAddress(offset)}`);
      this.temporaryBreakpoints.add(offset);
      await this.gdb.setBreakpoint(offset);
    }
  }

  public hasTemporaryBreakpoints(): boolean {
    return this.temporaryBreakpoints.size > 0;
  }

  public temporaryBreakpointAtAddress(pc: number): boolean {
    return this.temporaryBreakpoints.has(pc);
  }

  public async clearTemporaryBreakpoints(): Promise<void> {
    for (const address of this.temporaryBreakpoints.values()) {
      await this.gdb.removeBreakpoint(address);
    }
    this.temporaryBreakpoints.clear();
  }
}

export default BreakpointManager;
