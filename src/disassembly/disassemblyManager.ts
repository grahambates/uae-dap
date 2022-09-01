import { StackFrame, Source, Handles } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";

import { disassemble } from "./cpuDisassembler";
import { GdbClient } from "../gdbClient";
import { disassembleCopper } from "./copperDisassembler";
import { formatAddress, formatHexadecimal, splitLines } from "../utils/strings";
import VariableManager from "../variableManager";
import {
  DisassembledFile,
  disassembledFileToPath,
  disassembledFileFromPath,
} from "./disassembledFile";
import SourceMap from "../sourceMap";
import { basename } from "path";
import { Threads } from "../hardware";
import { StackPosition } from "../stackManager";

export interface DisassembledLine {
  text: string;
  isCopper: boolean;
}

export class DisassemblyManager {
  private sourceHandles = new Handles<DisassembledFile>();
  protected lineCache = new Map<number, DisassembledLine>();

  public constructor(
    private gdb: GdbClient,
    private variables: VariableManager,
    private sourceMap: SourceMap
  ) {}

  /**
   * Disassemble memory to CPU or Copper instructions
   */
  public async disassemble(
    args: DebugProtocol.DisassembleArguments & DisassembledFile
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    let { memoryReference } = args;
    let firstAddress: number | undefined;
    const hasOffset = args.offset || args.instructionOffset;
    if (memoryReference && hasOffset) {
      // Apply offset to address
      firstAddress = parseInt(args.memoryReference);
      if (args.offset) {
        firstAddress -= args.offset;
      }

      try {
        // Set memoryReference to segment address if found
        const location = this.sourceMap.lookupAddress(firstAddress);
        const segment = this.sourceMap.getSegmentInfo(location.segmentIndex);
        memoryReference = segment.address.toString();
      } catch (_) {
        // Not found
      }
    }

    if (
      args.segmentId === undefined &&
      !memoryReference &&
      !args.instructionCount
    ) {
      throw new Error(`Unable to disassemble; invalid parameters ${args}`);
    }

    // Check whether memoryReference points to previously disassembled copper lines if not specified.
    const isCopper =
      args.copper ?? this.isCopperLine(parseInt(args.memoryReference));

    let instructions =
      args.segmentId !== undefined
        ? await this.disassembleSegment(args.segmentId)
        : await this.disassembleAddressExpression(
            memoryReference,
            args.instructionCount * 4,
            args.offset ?? 0,
            isCopper
          );

    // Add source line data to instructions
    for (const instruction of instructions) {
      try {
        const line = this.sourceMap.lookupAddress(
          parseInt(instruction.address)
        );
        const filename = line.path;
        instruction.location = new Source(basename(filename), filename);
        instruction.line = line.line;
      } catch (_) {
        // Not found
      }
    }

    // Nothing left to do?
    if (!firstAddress || !args.instructionOffset) {
      return instructions;
    }

    // Find index of instruction matching first address
    const instructionIndex = instructions.findIndex(
      ({ address }) => parseInt(address) === firstAddress
    );
    if (instructionIndex === -1) {
      // Not found
      return instructions;
    }

    // Apply instruction offset
    const offsetIndex = instructionIndex + args.instructionOffset;

    // Negative offset:
    if (offsetIndex < 0) {
      // Pad instructions array with dummy entries
      const emptyArray = new Array<DebugProtocol.DisassembledInstruction>(
        -offsetIndex
      );
      const firstInstructionAddress = parseInt(instructions[0].address);
      let currentAddress = firstInstructionAddress - 4;
      for (let i = emptyArray.length - 1; i >= 0; i--) {
        emptyArray[i] = {
          address: formatHexadecimal(currentAddress),
          instruction: "-------",
        };
        currentAddress -= 4;
        if (currentAddress < 0) {
          currentAddress = 0;
        }
      }
      instructions = emptyArray.concat(instructions);
    }
    // Positive offset within range:
    if (offsetIndex > 0 && offsetIndex < instructions.length) {
      // Splice up to start??
      // TODO: check this
      instructions = instructions.splice(0, offsetIndex);
    }

    // Ensure instructions length matches requested count:
    if (instructions.length < args.instructionCount) {
      // Too few instructions:

      // Get address of last instruction
      const lastInstruction = instructions[instructions.length - 1];
      let lastAddress = parseInt(lastInstruction.address);
      if (lastInstruction.instructionBytes) {
        lastAddress += lastInstruction.instructionBytes.split(" ").length;
      }

      // Pad instructions array with dummy instructions at correct addresses
      const padLength = args.instructionCount - instructions.length;
      for (let i = 0; i < padLength; i++) {
        instructions.push({
          address: formatHexadecimal(lastAddress + i * 4),
          instruction: "-------",
        });
      }
    } else if (instructions.length > args.instructionCount) {
      // Too many instructions - truncate
      instructions = instructions.splice(0, args.instructionCount);
    }

    return instructions;
  }

  /**
   * Get disassembled file contents by source reference
   */
  public async getDisassembledFileContentsByRef(
    ref: number
  ): Promise<string | undefined> {
    const dAsmFile = this.getSourceByReference(ref);
    if (dAsmFile) {
      return this.getDisassembledFileContents(dAsmFile);
    }
  }

  /**
   * Get disassembled content for a .dgasm file path
   *
   * The filename contains tokens for the disassemble options
   */
  public async getDisassembledFileContentsByPath(
    path: string
  ): Promise<string> {
    const dAsmFile = disassembledFileFromPath(path);
    return this.getDisassembledFileContents(dAsmFile);
  }

  /**
   * Get text content for a disassembled source file
   */
  public async getDisassembledFileContents(
    dAsmFile: DisassembledFile
  ): Promise<string> {
    const instructions = await this.disassemble({
      memoryReference: "",
      instructionCount: 100,
      ...dAsmFile,
    });
    return instructions.map((v) => `${v.address}: ${v.instruction}`).join("\n");
  }

  public async disassembleLine(
    pc: number,
    threadId: number
  ): Promise<DisassembledLine> {
    const cached = this.lineCache.get(pc);
    if (cached) {
      return cached;
    }

    let text = formatAddress(pc) + ": ";
    const isCopper = threadId === Threads.COPPER;
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

    let segmentIndex = -1;
    let segmentOffset = 0;
    try {
      const location = this.sourceMap.lookupAddress(address);
      segmentIndex = location.segmentIndex;
      segmentOffset = location.segmentOffset;
    } catch (_) {
      // Not found
    }

    // is the pc on a opened segment ?
    if (segmentIndex >= 0 && !isCopper) {
      dAsmFile.segmentId = segmentIndex;
      line = await this.getLineNumberInDisassembledSegment(
        segmentIndex,
        segmentOffset
      );
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
    const filename = disassembledFileToPath(dAsmFile);
    sf.source = new Source(filename, filename);
    sf.source.sourceReference = this.sourceHandles.create(dAsmFile);
    sf.line = line;

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
      return this.variables.evaluate(addressExpression);
    }
  }

  private async getCopperAddress(copperIndex: number): Promise<number> {
    const copperHigh = copperIndex === 1 ? 0xdff080 : 0xdff084;
    const memory = await this.gdb.readMemory(copperHigh, 4);
    return parseInt(memory, 16);
  }
}
