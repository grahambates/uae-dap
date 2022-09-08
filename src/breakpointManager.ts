import { DebugProtocol } from "@vscode/debugprotocol";
import { BreakpointCode, GdbClient } from "./gdbClient";
import { logger } from "@vscode/debugadapter";
import SourceMap from "./sourceMap";
import { formatAddress } from "./utils/strings";
import { DisassemblyManager, isDisassembledFile } from "./disassembly";

export interface BreakpointReference {
  breakpoint: DebugProtocol.SourceBreakpoint;
  address: number;
  hitCount: number;
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
    Map<number, BreakpointReference>
  >();
  /** Source breakpoints mapped by address */
  private sourceBreakpointsByAddress = new Map<number, BreakpointReference>();
  /** Data breakpoints mapped by address */
  private dataBreakpoints = new Map<number, DebugProtocol.DataBreakpoint>();
  /** Instruction breakoint addresses */
  private instructionBreakpoints = new Set<number>();
  /** Temporary breakoint address groups */
  private temporaryBreakpoints = new Set<number>();

  public constructor(
    private gdb: GdbClient,
    private sourceMap: SourceMap,
    private disassembly: DisassemblyManager
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
      logger.log("Removing existing breakpoints for source " + sourceKey);
      for (const { address } of existing.values()) {
        this.sourceBreakpointsByAddress.delete(address);
        await this.gdb.removeBreakpoint(address);
      }
    }

    // Add new breakpoints
    const outBreakpoints: DebugProtocol.Breakpoint[] = [];
    const newRefs = new Map<number, BreakpointReference>();
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
        const ref: BreakpointReference = {
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

  public async setDataBreakpoints(
    breakpoints: DebugProtocol.DataBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    const outBreakpoints: DebugProtocol.Breakpoint[] = [];

    const types = {
      read: BreakpointCode.READ,
      write: BreakpointCode.WRITE,
      readWrite: BreakpointCode.ACCESS,
    };

    // Clear existing data points:
    for (const [address, bp] of this.dataBreakpoints.entries()) {
      const type = bp.accessType ? types[bp.accessType] : BreakpointCode.ACCESS;
      const size = 2; // TODO
      await this.gdb.removeBreakpoint(address, type, size);
    }
    this.dataBreakpoints.clear();

    // Process new data points:
    for (const bp of breakpoints) {
      const outBp: DebugProtocol.Breakpoint = {
        ...bp,
        verified: false,
      };
      outBreakpoints.push(outBp);
      try {
        // Parse dataId to get address
        const match = bp.dataId.match(/(?<name>.+)\((?<displayValue>.+)\)/);
        if (!match?.groups) {
          throw new Error("DataId format invalid");
        }
        const { displayValue } = match.groups;
        const size = 2; // TODO
        outBp.message = `${size} bytes watched starting at ${displayValue}`;

        logger.log(`Data breakoint: ${outBp.message}`);

        // Set in GDB:
        const address = parseInt(displayValue);
        const type = bp.accessType
          ? types[bp.accessType]
          : BreakpointCode.ACCESS;
        await this.gdb.setBreakpoint(address, type, size);

        this.dataBreakpoints.set(address, bp);
        outBp.verified = true;
      } catch (err) {
        if (err instanceof Error) outBp.message = err.message;
      }
    }
    return outBreakpoints;
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
        logger.log(`Instruction Breakpoint at ${formatAddress(address)}`);

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

  public sourceBreakpointAtAddress(
    address: number
  ): BreakpointReference | undefined {
    return this.sourceBreakpointsByAddress.get(address);
  }

  // Temporary breakpoints:

  public async addTemporaryBreakpoints(pc: number): Promise<void> {
    await this.clearTemporaryBreakpoints();

    // Set breakpoints at three possible offsets from PC
    const tmpBreakpoints = [pc + 1, pc + 2, pc + 4];
    for (const offset of tmpBreakpoints) {
      logger.log(`Temporary Breakpoint at ${formatAddress(offset)}`);
      this.temporaryBreakpoints.add(offset);
      await this.gdb.setBreakpoint(offset);
    }
  }

  public hasTemporaryBreakpoints(): boolean {
    return this.temporaryBreakpoints.size > 0;
  }

  public hasTemporaryBreakpointAt(pc: number): boolean {
    return Array.from(this.temporaryBreakpoints).includes(pc);
  }

  public async clearTemporaryBreakpoints(): Promise<void> {
    for (const address of this.temporaryBreakpoints.values()) {
      await this.gdb.removeBreakpoint(address);
    }
    this.temporaryBreakpoints.clear();
  }
}

export default BreakpointManager;
