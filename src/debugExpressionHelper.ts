import { DebugVariableResolver } from "./debugVariableResolver";
import { DebugProtocol } from "@vscode/debugprotocol";
import { StringUtils } from "./stringUtils";
import { parse, eval as expEval } from "expression-eval";

export class DebugExpressionHelper {
  public async getAddressFromExpression(
    expression: string,
    frameIndex: number | undefined,
    resolver: DebugVariableResolver
  ): Promise<number> {
    if (!expression) {
      throw new Error("Invalid address");
    }

    // Convert all numbers to decimal:
    let exp = expression
      // Hex
      .replace(/(\$|0x)([0-9a-f]+)/gi, (_, _2, d) => parseInt(d, 16).toString())
      // Octal
      .replace(/(@|0o)([0-7]+)/gi, (_, _2, d) => parseInt(d, 8).toString())
      // Binary
      .replace(/(%|0b)([0-1]+)/gi, (_, _2, d) => parseInt(d, 2).toString());

    // Return value if numeric
    if (exp.match(/^[0-9]+$/i)) {
      return parseInt(exp, 10);
    }

    // Replace all variables
    const matches = expression.matchAll(/([$#])\{([^}]+)\}/gi);
    for (const [fullStr, prefix, variableName] of matches) {
      const value = await (prefix === "$"
        ? resolver.getVariableValue(variableName, frameIndex)
        : resolver.getVariablePointedMemory(variableName, frameIndex));
      if (value) {
        exp = exp.replace(fullStr, parseInt(value).toString());
      }
    }

    // Evaluate expression
    const result = expEval(parse(exp), {});
    if (isNaN(result)) {
      throw new Error("Unable to evaluate expression: " + exp);
    }
    return Math.round(result);
  }

  public processOutputFromMemoryDump(
    memory: string,
    startAddress: number,
    mode: string,
    wordLength: number,
    rowLength: number
  ): [string, Array<DebugProtocol.Variable>] {
    let firstRow = "";
    const variables = new Array<DebugProtocol.Variable>();
    const chunks = StringUtils.chunk(memory.toString(), wordLength * 2);
    let i = 0;
    let rowCount = 0;
    let row = "";
    let nextAddress = startAddress;
    let lineAddress = startAddress;
    while (i < chunks.length) {
      if (rowCount > 0) {
        row += " ";
      }
      row += chunks[i];
      nextAddress += chunks[i].length / 2;
      if (rowCount >= rowLength - 1 || i === chunks.length - 1) {
        if (mode.indexOf("a") >= 0) {
          const asciiText = StringUtils.convertHexStringToASCII(
            row.replace(/\s+/g, ""),
            2
          );
          if (mode.indexOf("b") >= 0) {
            if (i === chunks.length - 1 && rowCount < rowLength - 1) {
              const chunksMissing = rowLength - 1 - rowCount;
              const padding = chunksMissing * wordLength * 2 + chunksMissing;
              for (let j = 0; j < padding; j++) {
                row += " ";
              }
            }
            row += " | ";
          } else {
            row = "";
          }
          row += asciiText;
        }
        variables.push({
          value: row,
          name: lineAddress.toString(16).padStart(8, "0"),
          variablesReference: 0,
        });
        if (firstRow.length <= 0) {
          firstRow = row;
        }
        rowCount = 0;
        lineAddress = nextAddress;
        row = "";
      } else {
        rowCount++;
      }
      i++;
    }
    return [firstRow, variables];
  }

  public processVariablesFromDisassembler(
    code: string,
    startAddress: number
  ): [string, Array<DebugProtocol.Variable>] {
    const variables = new Array<DebugProtocol.Variable>();
    const [firstRow, instructions] = this.processOutputFromDisassembler(
      code,
      startAddress
    );
    for (const instruction of instructions) {
      let ib = instruction.instructionBytes;
      if (!ib) {
        ib = "";
      }
      variables.push({
        value: ib.padEnd(26) + instruction.instruction,
        name: instruction.address,
        variablesReference: 0,
      });
    }
    return [firstRow, variables];
  }

  public processOutputFromDisassembler(
    code: string,
    startAddress: number
  ): [string, Array<DisassembledInstructionAdapter>] {
    let firstRow = "";
    const disassembledLines = new Array<DisassembledInstructionAdapter>();
    const lines = code.split(/\r\n|\r|\n/g);
    let i = 0;
    for (let l of lines) {
      l = l.trim();
      if (l.length > 0) {
        const elms = l.split("  ");
        if (elms.length > 2) {
          const instructionElms = elms[2].split("\t");
          let instruction = elms[2];
          if (instructionElms.length > 1) {
            instruction = instructionElms[0].padEnd(10) + instructionElms[1];
          }
          const offset = parseInt(elms[0], 16);
          const addOffset = startAddress + offset;
          const dInstr = DisassembledInstructionAdapter.createNumerical(
            addOffset,
            instruction
          );
          dInstr.line = i;
          dInstr.instructionBytes = elms[1];
          dInstr.column = 0;
          disassembledLines.push(dInstr);
          if (firstRow.length <= 0) {
            firstRow = elms[2].replace("\t", " ");
          }
        } else {
          const dInstr = DisassembledInstructionAdapter.createNumerical(i, l);
          dInstr.line = i;
          dInstr.instructionBytes = l;
          dInstr.column = 0;
          disassembledLines.push(dInstr);
          if (firstRow.length <= 0) {
            firstRow = l;
          }
        }
        i++;
      }
    }
    return [firstRow, disassembledLines];
  }
}

export class DisassembledInstructionAdapter
  implements DebugProtocol.DisassembledInstruction
{
  public address: string;
  public instructionBytes?: string;
  public instruction: string;
  public symbol?: string;
  public location?: DebugProtocol.Source;
  public line?: number;
  public column?: number;
  public endLine?: number;
  public endColumn?: number;
  private constructor(address: string, instruction: string) {
    this.address = address;
    this.instruction = instruction;
  }
  public static createNumerical(
    address: number,
    instruction: string
  ): DisassembledInstructionAdapter {
    const addr = DisassembledInstructionAdapter.getAddressString(address);
    return new DisassembledInstructionAdapter(addr, instruction);
  }
  public static createString(
    address: string,
    instruction: string
  ): DisassembledInstructionAdapter {
    return new DisassembledInstructionAdapter(address, instruction);
  }
  public getNumericalAddress(): number {
    if (this.address.startsWith("0x")) {
      return parseInt(this.address.substring(2), 16);
    } else {
      return parseInt(this.address);
    }
  }
  public static getAddressString(address: number): string {
    return "0x" + address.toString(16).padStart(8, "0");
  }
}
