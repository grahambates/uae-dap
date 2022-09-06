import { StackFrame, Source, Handles } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";

import { disassemble } from "./cpuDisassembler";
import { GdbClient } from "../gdbClient";
import { disassembleCopper } from "./copperDisassembler";
import { formatAddress, formatHexadecimal, splitLines } from "../utils/strings";
import Program from "../program";
import {
  DisassembledFile,
  disassembledFileToPath,
  disassembledFileFromPath,
} from "./disassembledFile";
import { StackPosition, THREAD_ID_COPPER } from "../debugSession";
import SourceMap from "../sourceMap";

export interface DisassembledLine {
  text: string;
  isCopper: boolean;
}

export class DisassemblyManager {
  private sourceHandles = new Handles<DisassembledFile>();
  protected lineCache = new Map<number, DisassembledLine>();

  public constructor(
    private gdb: GdbClient,
    private program: Program,
    private sourceMap: SourceMap
  ) {}

  public async disassembleLine(
    pc: number,
    threadId: number
  ): Promise<DisassembledLine> {
    const cached = this.lineCache.get(pc);
    if (cached) {
      return cached;
    }

    let text = formatAddress(pc) + ": ";
    const isCopper = threadId === THREAD_ID_COPPER;
    try {
      const memory = await this.gdb.readMemory(pc, 10);
      if (isCopper) {
        // Copper thread
        const lines = disassembleCopper(memory);
        text += lines[0].toString().split("    ")[0];
      } else {
        // CPU thread
        const { code } = await disassemble(memory);
        const lines = splitLines(code);
        let selectedLine = lines.find((l) => l.trim().length) ?? lines[0];
        const elms = selectedLine.split("  ");
        if (elms.length > 2) {
          selectedLine = elms[2];
        }
        text += selectedLine.trim().replace(/\s\s+/g, " ");
      }
      this.lineCache.set(pc, { text, isCopper });
    } catch (err) {
      console.error("Error ignored: " + (err as Error).message);
    }

    return { text, isCopper };
  }

  public isCopperLine(pc: number): boolean {
    const cached = this.lineCache.get(pc);
    return cached?.isCopper === true;
  }

  public async getStackFrame(
    stackPosition: StackPosition,
    threadId: number
  ): Promise<StackFrame> {
    const address = stackPosition.pc;
    const { text, isCopper } = await this.disassembleLine(address, threadId);

    const dAsmFile: DisassembledFile = {
      copper: isCopper,
      stackFrameIndex: stackPosition.index,
      instructionCount: 500,
    };

    let label = text.replace(/\s+/g, " ");
    let line = 1;

    // is the pc on a opened segment ?
    const location = this.sourceMap.lookupAddress(address);
    if (!location) {
      throw new Error("Unable to look up addres " + address);
    }
    const { segmentIndex: segmentId, segmentOffset: offset } = location;
    if (segmentId >= 0 && !isCopper) {
      dAsmFile.segmentId = segmentId;
      line = await this.getLineNumberInDisassembledSegment(segmentId, offset);
    } else {
      dAsmFile.memoryReference = "$" + address.toString(16);
      if (isCopper) {
        // Search for selected copper list
        const cop1Addr = await this.getCopperAddress(1);
        const cop2Addr = await this.getCopperAddress(2);
        const lineInCop1 = cop1Addr
          ? Math.floor((address - cop1Addr + 4) / 4)
          : -1;
        const lineInCop2 = cop2Addr
          ? Math.floor((address - cop2Addr + 4) / 4)
          : -1;

        if (
          lineInCop1 >= 0 &&
          (lineInCop2 === -1 || lineInCop1 <= lineInCop2)
        ) {
          dAsmFile.memoryReference = "1";
          line = lineInCop1;
          label = "cop1";
        } else if (lineInCop2 >= 0) {
          dAsmFile.memoryReference = "2";
          line = lineInCop2;
          label = "cop2";
        }
        dAsmFile.instructionCount = line + 499;
      }
    }

    const sf = new StackFrame(stackPosition.index, label);
    sf.instructionPointerReference = formatHexadecimal(address);

    if (isCopper) {
      const filename = disassembledFileToPath(dAsmFile);
      sf.source = new Source(filename, filename);
      sf.source.sourceReference = this.sourceHandles.create(dAsmFile);
      sf.line = line;
    }

    return sf;
  }

  public getSourceByReference(ref: number): DisassembledFile | undefined {
    return this.sourceHandles.get(ref);
  }

  public async disassembleSegment(
    segmentId: number
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    // ask for memory dump
    const { address, size } = this.sourceMap.getSegmentInfo(segmentId);
    const memory = await this.gdb.readMemory(address, size);
    // disassemble the code
    const { instructions } = await disassemble(memory, address);
    return instructions;
  }

  public async disassembleAddressExpression(
    addressExpression: string,
    length: number,
    offset: number | undefined,
    isCopper: boolean
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    let address = await this.evaluateAddress(addressExpression, isCopper);
    if (address === undefined) {
      throw new Error("Unable to resolve address expression void returned");
    }
    if (offset) {
      address += offset;
    }
    return this.disassembleAddress(address, length, isCopper);
  }

  public async disassembleAddress(
    address: number,
    length: number,
    isCopper?: boolean
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    // if (!this.gdb.isConnected()) {
    //   throw new Error("Debugger not started");
    // }
    const memory = await this.gdb.readMemory(address, length);
    if (isCopper) {
      return disassembleCopper(memory).map((inst, i) => ({
        instructionBytes: inst.getInstructionBytes(),
        address: formatHexadecimal(address + i * 4),
        instruction: inst.toString(),
      }));
    } else {
      // disassemble the code
      const { instructions } = await disassemble(memory, address);
      return instructions;
    }
  }

  public async getAddressForFileEditorLine(
    filePath: string,
    lineNumber: number
  ): Promise<number> {
    let instructions: void | DebugProtocol.DisassembledInstruction[];
    if (lineNumber > 0) {
      const dAsmFile = disassembledFileFromPath(filePath);
      if (dAsmFile.segmentId !== undefined) {
        instructions = await this.disassembleSegment(dAsmFile.segmentId);
      } else {
        // Path from outside segments
        if (dAsmFile.memoryReference && dAsmFile.instructionCount) {
          const address = await this.evaluateAddress(
            dAsmFile.memoryReference,
            dAsmFile.copper
          );
          instructions = await this.disassembleAddress(
            address,
            dAsmFile.instructionCount,
            dAsmFile.copper
          );
        }
      }
      if (instructions) {
        const searchedLN = lineNumber - 1;
        if (searchedLN < instructions.length) {
          return parseInt(instructions[searchedLN].address, 16);
        } else {
          throw new Error(
            `Searched line ${searchedLN} greater than file "${filePath}" length: ${instructions.length}`
          );
        }
      } else {
        throw new Error(`Searched line ${lineNumber} has no instructions`);
      }
    } else {
      throw new Error(`Invalid line number: '${lineNumber}'`);
    }
  }

  private async getLineNumberInDisassembledSegment(
    segmentId: number,
    offset: number
  ): Promise<number> {
    const { address, size } = this.sourceMap.getSegmentInfo(segmentId);
    const memory = await this.gdb.readMemory(address, size);
    const { instructions } = await disassemble(memory);
    const index = instructions.findIndex(
      (instr) => parseInt(instr.address) === offset
    );
    return index + 1;
  }

  private evaluateAddress(addressExpression: string, isCopper?: boolean) {
    if (isCopper && (addressExpression === "1" || addressExpression === "2")) {
      // Retrieve the copper address
      return this.getCopperAddress(parseInt(addressExpression));
    } else {
      return this.program.evaluate(addressExpression);
    }
  }

  private async getCopperAddress(copperIndex: number): Promise<number> {
    const copperHigh = copperIndex === 1 ? 0xdff080 : 0xdff084;
    const memory = await this.gdb.readMemory(copperHigh, 4);
    return parseInt(memory, 16);
  }
}
