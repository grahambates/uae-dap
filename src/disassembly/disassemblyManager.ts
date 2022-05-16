import { StackFrame, Source } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { URI as Uri } from "vscode-uri";

import { disassemble } from "./cpuDisassembler";
import { GdbProxy } from "../gdb";
import { evaluateExpression, VariableResolver } from "../expressions";
import { disassembleCopper } from "./copperDisassembler";
import { formatHexadecimal } from "../strings";
import { getCopperAddress } from "../memory";

export class DisassembledFile {
  public static readonly DGBFILE_SCHEME = "disassembly";
  public static readonly DGBFILE_SEG_SEPARATOR = "seg_";
  public static readonly DGBFILE_COPPER_SEPARATOR = "copper_";
  public static readonly DGBFILE_EXTENSION = "dbgasm";

  private segmentId: number | undefined;
  private stackFrameIndex: number | undefined;
  private addressExpression: string | undefined;
  private length: number | undefined;
  private copper = false;
  private path = "";

  public setSegmentId(segmentId: number): DisassembledFile {
    this.segmentId = segmentId;
    return this;
  }

  public getSegmentId(): number | undefined {
    return this.segmentId;
  }

  public setStackFrameIndex(stackFrameIndex: number): DisassembledFile {
    this.stackFrameIndex = stackFrameIndex;
    return this;
  }

  public getStackFrameIndex(): number | undefined {
    return this.stackFrameIndex;
  }

  public setAddressExpression(addressExpression: string): DisassembledFile {
    this.addressExpression = addressExpression;
    return this;
  }

  public getAddressExpression(): string | undefined {
    return this.addressExpression;
  }

  public setLength(length: number): DisassembledFile {
    this.length = length;
    return this;
  }

  public getLength(): number | undefined {
    return this.length;
  }

  public isSegment(): boolean {
    return this.segmentId !== undefined;
  }

  public setCopper(isCopper: boolean): DisassembledFile {
    this.copper = isCopper;
    return this;
  }

  public isCopper(): boolean {
    return this.copper;
  }

  public toString(): string {
    if (this.isSegment()) {
      return `${this.path}${DisassembledFile.DGBFILE_SEG_SEPARATOR}${this.segmentId}.${DisassembledFile.DGBFILE_EXTENSION}`;
    } else if (this.isCopper()) {
      return `${this.path}${DisassembledFile.DGBFILE_COPPER_SEPARATOR}${this.addressExpression}__${this.length}.${DisassembledFile.DGBFILE_EXTENSION}`;
    } else {
      return `${this.path}${this.stackFrameIndex}__${this.addressExpression}__${this.length}.${DisassembledFile.DGBFILE_EXTENSION}`;
    }
  }

  public static fromPath(path: string): DisassembledFile {
    let localPath = path;
    const dAsmFile = new DisassembledFile();
    const lastSepPos = localPath.lastIndexOf("/");
    if (lastSepPos >= 0) {
      localPath = localPath.substring(lastSepPos + 1);
      dAsmFile.path = path.substring(0, lastSepPos + 1);
    }
    const indexOfExt = localPath.lastIndexOf(
      DisassembledFile.DGBFILE_EXTENSION
    );
    if (indexOfExt > 0) {
      localPath = localPath.substring(0, indexOfExt - 1);
    }
    const segLabelPos = localPath.indexOf(
      DisassembledFile.DGBFILE_SEG_SEPARATOR
    );
    const copperLabelPos = localPath.indexOf(
      DisassembledFile.DGBFILE_COPPER_SEPARATOR
    );
    if (segLabelPos >= 0) {
      const segId = parseInt(localPath.substring(segLabelPos + 4));
      dAsmFile.setSegmentId(segId);
    } else if (copperLabelPos >= 0) {
      const pathParts = localPath
        .substring(DisassembledFile.DGBFILE_COPPER_SEPARATOR.length)
        .split("__");
      if (pathParts.length > 1) {
        const address = pathParts[0];
        const length = parseInt(pathParts[1]);
        dAsmFile
          .setAddressExpression(address)
          .setLength(length)
          .setCopper(true);
      }
    } else {
      const pathParts = localPath.split("__");
      if (pathParts.length > 1) {
        const stackFrameIndex = parseInt(pathParts[0]);
        const address = pathParts[1];
        const length = parseInt(pathParts[2]);
        dAsmFile
          .setStackFrameIndex(stackFrameIndex)
          .setAddressExpression(address)
          .setLength(length);
      }
    }
    return dAsmFile;
  }

  public toURI(): Uri {
    // Code to replace #, it is not done by the Uri.parse
    const filename = this.toString().replace("#", "%23");
    return Uri.parse(`${DisassembledFile.DGBFILE_SCHEME}:${filename}`);
  }

  public static isDebugAsmFile(path: string): boolean {
    return path.endsWith(DisassembledFile.DGBFILE_EXTENSION);
  }
}

export class DisassembleAddressArguments
  implements DebugProtocol.DisassembleArguments
{
  memoryReference: string;
  offset?: number;
  instructionOffset?: number;
  instructionCount: number;
  resolveSymbols?: boolean;
  segmentId?: number;
  stackFrameIndex?: number;
  addressExpression?: string;
  copper: boolean;
  constructor(
    addressExpression?: string | undefined,
    instructionCount?: number | undefined,
    isCopper?: boolean | undefined
  ) {
    this.addressExpression = addressExpression;
    if (addressExpression) {
      this.memoryReference = addressExpression;
    } else {
      this.memoryReference = "";
    }
    if (instructionCount) {
      this.instructionCount = instructionCount;
    } else {
      this.instructionCount = 100;
    }
    if (isCopper) {
      this.copper = isCopper;
    } else {
      this.copper = false;
    }
  }

  public static copy(
    args: DebugProtocol.DisassembleArguments,
    isCopper: boolean
  ): DisassembleAddressArguments {
    const newArgs = new DisassembleAddressArguments(
      args.memoryReference,
      args.instructionCount,
      isCopper
    );
    newArgs.offset = args.offset;
    newArgs.instructionOffset = args.instructionOffset;
    return newArgs;
  }
}

export class DisassemblyManager {
  public constructor(
    private gdbProxy: GdbProxy,
    private variableResolver: VariableResolver
  ) {}

  public async getStackFrame(
    stackFrameIndex: number,
    address: number,
    stackFrameLabel: string,
    isCopper: boolean
  ): Promise<StackFrame> {
    const dAsmFile = new DisassembledFile();
    const length = 500;
    let lineNumber = 1;
    dAsmFile.setCopper(isCopper);
    // is the pc on a opened segment ?
    const [segmentId, offset] = this.gdbProxy.toRelativeOffset(address);
    if (segmentId >= 0 && !isCopper) {
      // We have a segment
      dAsmFile.setSegmentId(segmentId);
      let returnedLineNumber;
      try {
        returnedLineNumber = await this.getLineNumberInDisassembledSegment(
          segmentId,
          offset
        );
      } catch (err) {
        // Nothing to do
        lineNumber = -1;
      }
      if (returnedLineNumber || returnedLineNumber === 0) {
        lineNumber = returnedLineNumber;
      }
    } else {
      let newAddress = address;
      if (isCopper) {
        // Search for selected copper list
        // Read
        let lineInCop1 = -1;
        let lineInCop2 = -1;
        const cop1Addr = await getCopperAddress(1, this.gdbProxy);
        if (cop1Addr) {
          lineInCop1 = Math.floor((address - cop1Addr + 4) / 4);
        }
        const cop2Addr = await getCopperAddress(1, this.gdbProxy);
        if (cop2Addr) {
          lineInCop2 = Math.floor((address - cop2Addr + 4) / 4);
        }
        if (cop1Addr && lineInCop1 >= 0) {
          if (cop2Addr && lineInCop2 >= 0) {
            if (lineInCop1 <= lineInCop2) {
              newAddress = cop1Addr;
              lineNumber = lineInCop1;
            } else {
              newAddress = cop2Addr;
              lineNumber = lineInCop2;
            }
          } else {
            newAddress = cop1Addr;
            lineNumber = lineInCop1;
          }
        } else if (cop2Addr && lineInCop2 >= 0) {
          newAddress = cop2Addr;
          lineNumber = lineInCop2;
        }
      }
      dAsmFile
        .setStackFrameIndex(stackFrameIndex)
        .setAddressExpression(`$${newAddress.toString(16)}`)
        .setLength(length);
    }
    const url = `${DisassembledFile.DGBFILE_SCHEME}:///${dAsmFile}`;
    let sf;
    if (lineNumber >= 0 && isCopper) {
      sf = new StackFrame(
        stackFrameIndex,
        stackFrameLabel,
        new Source(dAsmFile.toString(), url),
        lineNumber,
        1
      );
    } else {
      sf = new StackFrame(stackFrameIndex, stackFrameLabel);
    }
    sf.instructionPointerReference = formatHexadecimal(address);
    return sf;
  }

  public async getLineNumberInDisassembledSegment(
    segmentId: number,
    offset: number
  ): Promise<number> {
    const memory = await this.gdbProxy.getSegmentMemory(segmentId);
    // disassemble the code
    const { instructions } = await disassemble(memory);
    let line = 1;
    for (const instr of instructions) {
      if (parseInt(instr.address) === offset) {
        return line;
      }
      line++;
    }
    throw new Error(
      `Cannot retrieve line for segment ${segmentId}, offset ${offset}: line not found`
    );
  }

  public async disassembleSegment(
    segmentId: number
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    // ask for memory dump
    const memory = await this.gdbProxy.getSegmentMemory(segmentId);
    const startAddress = this.gdbProxy.toAbsoluteOffset(segmentId, 0);
    // disassemble the code
    const { instructions } = await disassemble(memory, startAddress);
    return instructions;
  }

  public async disassembleAddress(
    addressExpression: string,
    length: number,
    offset: number | undefined,
    isCopper: boolean
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    let searchedAddress: number | void;
    if (isCopper && (addressExpression === "1" || addressExpression === "2")) {
      // Retrieve the copper address
      searchedAddress = await getCopperAddress(
        parseInt(addressExpression),
        this.gdbProxy
      );
    } else {
      searchedAddress = await evaluateExpression(
        addressExpression,
        undefined,
        this.variableResolver
      );
    }
    if (searchedAddress || searchedAddress === 0) {
      if (offset) {
        searchedAddress += offset;
      }
      return this.disassembleNumericalAddress(
        searchedAddress,
        length,
        isCopper
      );
    } else {
      throw new Error("Unable to resolve address expression void returned");
    }
  }

  public async disassembleNumericalAddress(
    searchedAddress: number,
    length: number,
    isCopper: boolean
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    const address = searchedAddress;
    if (isCopper) {
      const memory = await this.gdbProxy.getMemory(address, length);
      const startAddress = address;
      const instructions = disassembleCopper(memory);
      const variables = new Array<DebugProtocol.DisassembledInstruction>();
      let offset = 0;
      for (const i of instructions) {
        const addOffset = startAddress + offset;
        variables.push({
          instructionBytes: i.getInstructionBytes(),
          address: formatHexadecimal(addOffset),
          instruction: i.toString(),
        });
        // 4 addresses : 32b / address
        offset += 4;
      }
      return variables;
    } else {
      // ask for memory dump
      if (!this.gdbProxy.isConnected()) {
        throw new Error("Debugger not started");
      }
      const memory = await this.gdbProxy.getMemory(address, length);
      const startAddress = address;
      // disassemble the code
      const { instructions } = await disassemble(memory, startAddress);
      return instructions;
    }
  }

  public async disassembleNumericalAddressCPU(
    searchedAddress: number,
    length: number
  ): Promise<Array<DebugProtocol.DisassembledInstruction>> {
    const address = searchedAddress;
    // ask for memory dump
    const memory = await this.gdbProxy.getMemory(address, length);
    const startAddress = address;
    // disassemble the code
    const { instructions } = await disassemble(memory, startAddress);
    return instructions;
  }

  public async disassembleRequest(
    args: DisassembleAddressArguments
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    let offset = 0;
    if (args.offset) {
      offset += args.offset;
    }
    if (args.copper) {
      if (args.addressExpression && args.instructionCount) {
        return this.disassembleAddress(
          args.addressExpression,
          args.instructionCount * 4,
          offset,
          args.copper
        );
      } else {
        throw new Error(`Unable to disassemble; invalid parameters ${args}`);
      }
    } else {
      if (args.segmentId !== undefined) {
        return this.disassembleSegment(args.segmentId);
      } else if (args.addressExpression && args.instructionCount) {
        return this.disassembleAddress(
          args.addressExpression,
          args.instructionCount * 4,
          offset,
          args.copper
        );
      } else {
        throw new Error(`Unable to disassemble; invalid parameters ${args}`);
      }
    }
  }

  public async getAddressForFileEditorLine(
    filePath: string,
    lineNumber: number
  ): Promise<number> {
    let instructions: void | DebugProtocol.DisassembledInstruction[];
    if (lineNumber > 0) {
      const dAsmFile = DisassembledFile.fromPath(filePath);
      if (dAsmFile.isSegment()) {
        const segmentId = dAsmFile.getSegmentId();
        if (segmentId !== undefined) {
          instructions = await this.disassembleSegment(segmentId);
        } else {
          throw new Error(`SegmentId undefined in path ${filePath}`);
        }
      } else {
        // Path from outside segments
        const address = dAsmFile.getAddressExpression();
        const length = dAsmFile.getLength();
        if (address !== undefined && length !== undefined) {
          instructions = await this.disassembleAddress(
            address,
            length,
            0,
            dAsmFile.isCopper()
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
}
