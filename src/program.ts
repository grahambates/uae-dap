import { DebugProtocol } from "@vscode/debugprotocol";
import {
  Handles,
  Scope,
  Source,
  StackFrame,
  Thread,
} from "@vscode/debugadapter";
import { basename } from "path";
import { parse, eval as expEval } from "expression-eval";

import { customRegisterAddresses } from "./customRegisters";
import {
  disassemble,
  disassembleCopper,
  DisassemblyManager,
} from "./disassembly";
import { GdbProxy, GdbSegment, GdbStackPosition, GdbThread } from "./gdb";
import { FileInfo, LineInfo, SegmentLocation } from "./fileInfo";
import {
  chunk,
  compareStringsLowerCase,
  formatAddress,
  formatHexadecimal,
  formatNumber,
  hexStringToASCII,
  NumberFormat,
} from "./utils/strings";

export enum ScopeType {
  Registers,
  Segments,
  Symbols,
  StatusRegister,
  Expression,
}

export interface ScopeReference {
  type: ScopeType;
  frameId: number;
}

export interface SourceConstantResolver {
  getSourceConstants(sourceFiles: string[]): Promise<Record<string, number>>;
}

class Program {
  private scopes = new Handles<ScopeReference>();
  /** Variables lookup by handle */
  private referencedVariables = new Map<number, DebugProtocol.Variable[]>();
  /** All the symbols in the file */
  private symbols = new Map<string, number>();
  /** Manager of disassembled code */
  private disassemblyManager: DisassemblyManager;
  /** Lazy loaded constants extracted from current file source */
  private sourceConstants?: Record<string, number>;
  /** Store format options for specific variables */
  private variableFormatterMap = new Map<string, NumberFormat>();

  private constructor(
    private gdb: GdbProxy,
    private fileInfo: FileInfo,
    private constantResolver?: SourceConstantResolver
  ) {
    this.disassemblyManager = new DisassemblyManager(gdb, this);
  }

  public static async create(
    filename: string,
    gdb: GdbProxy,
    pathReplacements?: Record<string, string>,
    sourcesRootPaths?: Array<string>,
    constantResolver?: SourceConstantResolver
  ) {
    const fileParser = await FileInfo.create(
      filename,
      pathReplacements,
      sourcesRootPaths
    );
    return new Program(gdb, fileParser, constantResolver);
  }

  /**
   * Updates the segments addresses of the hunks
   *
   * @param segments The list of returned segments from the debugger
   */
  public updateSegments(segments: GdbSegment[]): void {
    const lastPos = this.fileInfo.hunks.length;
    for (let posSegment = 0; posSegment < lastPos; posSegment++) {
      // Segments in order of file
      const hunk = this.fileInfo.hunks[posSegment];
      let segment: GdbSegment;
      let address: number;
      if (posSegment >= segments.length) {
        // Segment not declared by the protocol
        segment = {
          id: posSegment,
          address: 0,
          name: "",
          size: hunk.allocSize,
        };
        address = this.gdb.addSegment(segment);
      } else {
        segment = segments[posSegment];
        address = segment.address;
        segment.size = hunk.allocSize;
      }
      hunk.segmentsId = posSegment;
      hunk.segmentsAddress = address;
      // Retrieve the symbols
      if (hunk.symbols) {
        for (const s of hunk.symbols) {
          this.symbols.set(s.name, s.offset + address);
        }
      }
    }
  }

  /**
   * Read memory from address
   */
  public async getMemory(address: number, size = 4): Promise<number> {
    await this.gdb.waitConnected();
    const mem = await this.gdb.getMemory(address, size);
    return parseInt(mem, 16);
  }

  /**
   * Get scopes for frame ID
   */
  public getScopes(frameId: number): DebugProtocol.Scope[] {
    return [
      new Scope(
        "Registers",
        this.scopes.create({ type: ScopeType.Registers, frameId }),
        false
      ),
      new Scope(
        "Segments",
        this.scopes.create({ type: ScopeType.Segments, frameId }),
        true
      ),
      new Scope(
        "Symbols",
        this.scopes.create({ type: ScopeType.Symbols, frameId }),
        true
      ),
    ];
  }

  /**
   * Get all threads
   */
  public async getThreads(): Promise<DebugProtocol.Thread[]> {
    await this.gdb.waitConnected();
    const threadIds = await this.gdb.getThreadIds();
    return threadIds.map(
      (t) => new Thread(t.getId(), this.gdb.getThreadDisplayName(t))
    );
  }

  /**
   * Get stack trace for thread
   */
  public async getStackTrace(
    thread: GdbThread,
    stackPositions: GdbStackPosition[]
  ): Promise<StackFrame[]> {
    const stackFrames = [];

    for (const p of stackPositions) {
      let sf: StackFrame | undefined;

      if (p.segmentId >= 0) {
        const line = await this.fileInfo.findLineAtLocation(
          p.segmentId,
          p.offset
        );
        if (line) {
          let address = formatAddress(p.pc);
          const inst = line.lineText?.split(";")[0];
          if (inst) {
            address += ": " + inst.trim().replace(/\s\s+/g, " ");
          }
          const source = new Source(basename(line.filename), line.filename);
          sf = new StackFrame(p.index, address, source, line.lineNumber, 1);
          sf.instructionPointerReference = formatHexadecimal(p.pc);
        }
      }

      // Get disassembled stack frame if not set
      if (!sf) {
        sf = await this.disassemblyManager.getStackFrame(p, thread);
      }
      stackFrames.push(sf);
    }

    return stackFrames;
  }

  /**
   * Disassemble memory to CPU or Copper instructions
   */
  public async disassemble(
    args: DebugProtocol.DisassembleArguments
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    const address = parseInt(args.memoryReference);
    const isCopper = this.disassemblyManager.isCopperLine(address);
    const segments = this.gdb.getSegments();

    let { memoryReference } = args;

    let firstAddress = undefined;
    const hasOffset = args.offset || args.instructionOffset;
    if (memoryReference && hasOffset && segments) {
      firstAddress = parseInt(args.memoryReference);
      if (args.offset) {
        firstAddress -= args.offset;
      }
      const segment = this.findSegmentContainingAddress(firstAddress, segments);
      if (segment) {
        memoryReference = segment.address.toString();
      }
    }

    if (!memoryReference || !args.instructionCount) {
      throw new Error(`Unable to disassemble; invalid parameters ${args}`);
    }
    let instructions = await this.disassemblyManager.disassembleAddress(
      memoryReference,
      args.instructionCount * 4,
      args.offset ?? 0,
      isCopper
    );

    if (firstAddress) {
      let iIndex = undefined;
      let index = 0;
      const firstInstructionAddress = parseInt(instructions[0].address);
      for (const instruction of instructions) {
        if (parseInt(instruction.address) === firstAddress) {
          iIndex = index;
          break;
        }
        index++;
      }
      if (iIndex !== undefined && args.instructionOffset) {
        const start = iIndex + args.instructionOffset;
        if (start < 0) {
          const emptyArray = new Array<DebugProtocol.DisassembledInstruction>(
            -start
          );
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
        } else if (start > 0 && start < instructions.length) {
          instructions = instructions.splice(0, start);
        }
        if (instructions.length < args.instructionCount) {
          const emptyArray = new Array<DebugProtocol.DisassembledInstruction>(
            args.instructionCount - instructions.length
          );
          const instr = instructions[instructions.length - 1];
          let lastAddress = parseInt(instr.address);
          if (instr.instructionBytes) {
            lastAddress += instr.instructionBytes.split(" ").length;
          }
          for (let i = 0; i < emptyArray.length; i++) {
            emptyArray[i] = {
              address: formatHexadecimal(lastAddress + i * 4),
              instruction: "-------",
            };
          }
          instructions = instructions.concat(emptyArray);
        } else if (instructions.length > args.instructionCount) {
          instructions = instructions.splice(0, args.instructionCount);
        }
      }
    }

    // Add source lines to instructions
    if (segments) {
      for (const instruction of instructions) {
        const foundLine = await this.findSourceLine(
          parseInt(instruction.address),
          segments
        );
        if (foundLine) {
          instruction.location = new Source(
            basename(foundLine.filename),
            foundLine.filename
          );
          instruction.line = foundLine.lineNumber;
        }
      }
    }

    return instructions;
  }

  // Variables:

  /**
   * Get object containing all variables and constants
   */
  public async getVariables(frameId?: number): Promise<Record<string, number>> {
    await this.gdb.waitConnected();
    const registers = await this.gdb.registers(frameId || null);
    const registerEntries = registers.reduce<Record<string, number>>(
      (acc, v) => {
        acc[v.name] = v.value;
        return acc;
      },
      {}
    );
    const sourceConstants = await this.getSourceConstants();

    return {
      ...Object.fromEntries(this.symbols),
      ...customRegisterAddresses,
      ...sourceConstants,
      ...registerEntries,
    };
  }

  /**
   * Lazy load constants from parsed source files
   */
  private async getSourceConstants(): Promise<Record<string, number>> {
    if (this.sourceConstants) {
      return this.sourceConstants;
    }
    const sourceFiles = await this.fileInfo.getSourceFiles();
    const sourceConstants = await this.constantResolver?.getSourceConstants(
      sourceFiles
    );
    this.sourceConstants = sourceConstants ?? {};
    return this.sourceConstants;
  }

  /**
   * Retrieve variables for a given variable reference i.e. scope
   */
  public async getVariablesByReference(
    variablesReference: number
  ): Promise<DebugProtocol.Variable[]> {
    // Try to look up stored reference
    const variables = this.referencedVariables.get(variablesReference);
    if (variables) {
      return variables;
    }

    // Get reference info in order to populate variables
    const { type, frameId } = this.getScopeReference(variablesReference);
    await this.gdb.waitConnected();

    switch (type) {
      case ScopeType.Registers:
        return this.getRegisterVariables(frameId);
      case ScopeType.Segments:
        return this.getSegmentVariables();
      case ScopeType.Symbols:
        return this.getSymbolVariables();
    }
    throw new Error("Invalid reference");
  }

  /**
   * Get information about the scope associated with a variables reference
   */
  public getScopeReference(variablesReference: number): ScopeReference {
    const scopeRef = this.scopes.get(variablesReference);
    if (!scopeRef) {
      throw new Error("Reference not found");
    }
    return scopeRef;
  }

  private async getRegisterVariables(
    frameId: number
  ): Promise<DebugProtocol.Variable[]> {
    const registers = await this.gdb.registers(frameId);

    // Stack register properties go in their own variables array to be fetched later by reference
    const sr = registers
      .filter(({ name }) => name.startsWith("SR_"))
      .map(({ name, value }) => ({
        name: name.substring(3),
        type: "register",
        value: this.formatVariable(name, value, NumberFormat.DECIMAL),
        variablesReference: 0,
        memoryReference: value.toString(),
      }));

    const srScope = this.scopes.create({
      type: ScopeType.StatusRegister,
      frameId,
    });
    this.referencedVariables.set(srScope, sr);

    // All other registers returned
    return registers
      .filter(({ name }) => !name.startsWith("SR_"))
      .map(({ name, value }) => ({
        name,
        type: "register",
        value: this.formatVariable(name, value),
        variablesReference: name.startsWith("sr") ? srScope : 0, // Link SR to its properties
        memoryReference: value.toString(),
      }));
  }

  private getSegmentVariables(): DebugProtocol.Variable[] {
    const segments = this.gdb.getSegments() ?? [];
    return segments.map((s, i) => {
      const name = `Segment #${i}`;
      return {
        name,
        type: "segment",
        value: `${this.formatVariable(name, s.address)} {size:${s.size}}`,
        variablesReference: 0,
        memoryReference: s.address.toString(),
      };
    });
  }

  private getSymbolVariables(): DebugProtocol.Variable[] {
    return Array.from(this.symbols.entries())
      .sort(compareStringsLowerCase)
      .map(([name, value]) => ({
        name,
        type: "symbol",
        value: this.formatVariable(name, value),
        variablesReference: 0,
        memoryReference: value.toString(),
      }));
  }

  /**
   * Set the value of a variable
   *
   * Only registers are supported.
   */
  public setVariable(
    variablesReference: number,
    name: string,
    value: string
  ): Promise<string> {
    const scopeRef = this.scopes.get(variablesReference);
    if (scopeRef?.type !== ScopeType.Registers) {
      throw new Error("This variable cannot be set");
    }
    return this.gdb.setRegister(name, value);
  }

  // Variable formatting:

  /**
   * Format a variable as a string in the preferred NumberFormat
   */
  public formatVariable(
    variableName: string,
    value: number,
    defaultFormat: NumberFormat = NumberFormat.HEXADECIMAL
  ): string {
    const format = this.variableFormatterMap.get(variableName) || defaultFormat;
    return formatNumber(value, format);
  }

  /**
   * Set the preferred format for a specific variable
   */
  public setVariableFormat(variableName: string, format: NumberFormat) {
    this.variableFormatterMap.set(variableName, format);
  }

  // Expressions:

  public async evaluateExpression({
    expression,
    frameId,
    context,
  }: DebugProtocol.EvaluateArguments): Promise<{
    result: string;
    type?: string;
    variablesReference: number;
  }> {
    await this.gdb.waitConnected();
    let variables: DebugProtocol.Variable[] | undefined;
    let result: string | undefined;

    // Find expression type:
    const isRegister = expression.match(/^([ad][0-7]|pc|sr)$/i) !== null;
    const isMemRead = expression.match(/^m\s/) !== null;
    const isMemWrite = expression.match(/^M\s/) !== null;
    const isSymbol = this.symbols.has(expression);

    switch (true) {
      case isRegister: {
        const [address] = await this.gdb.getRegister(expression, frameId);
        if (expression.startsWith("a") && context === "watch") {
          variables = await this.readMemoryAsVariables(address, 100, 2, 4);
        } else {
          result = this.formatVariable(expression, address);
        }
        break;
      }
      case isMemWrite:
        variables = await this.writeMemoryExpression(expression, frameId);
        break;
      case isMemRead:
        variables = await this.readMemoryExpression(expression, frameId);
        break;
      case isSymbol: {
        const address = <number>this.symbols.get(expression);
        const length = context === "watch" ? 104 : 24;
        variables = await this.readMemoryAsVariables(address, length, 2, 4);
        break;
      }
      // Evaluate
      default: {
        const address = await this.evaluate(expression, frameId);
        result = formatHexadecimal(address);
      }
    }

    // Build response for either single value or array
    if (result) {
      return {
        result,
        type: "string",
        variablesReference: 0,
      };
    }
    if (variables) {
      const variablesReference = this.scopes.create({
        type: ScopeType.Expression,
        frameId: frameId ?? 0,
      });
      this.referencedVariables.set(variablesReference, variables);

      return {
        result: variables[0].value.replace(
          /^[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}\s+/,
          ""
        ),
        type: "array",
        variablesReference,
      };
    }
    throw new Error("No result");
  }

  public async evaluate(
    expression: string,
    frameIndex?: number
  ): Promise<number> {
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

    const variables = await this.getVariables(frameIndex);

    // Replace all variables
    const matches = expression.matchAll(/([$#])\{([^}]+)\}/gi);
    for (const [fullStr, prefix, variableName] of matches) {
      let value = variables[variableName];
      if (value) {
        if (prefix === "#") {
          value = await this.getMemory(value);
        }
        exp = exp.replace(fullStr, value.toString());
      }
    }

    // Evaluate expression
    const result = expEval(parse(exp), variables);
    if (isNaN(result)) {
      throw new Error("Unable to evaluate expression: " + exp);
    }
    return Math.round(result);
  }

  private async writeMemoryExpression(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    const matches =
      /M\s*(?<addr>[{}$#0-9a-z_]+)\s*=\s*(?<data>[0-9a-z_]+)/i.exec(expression);
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expression not recognized");
    }
    const address = await this.evaluate(groups.addr, frameId);
    await this.gdb.setMemory(address, groups.data);
    return this.readMemoryAsVariables(address, groups.data.length);
  }

  private async readMemoryExpression(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    // Parse expression
    const matches =
      /m\s*(?<address>[^,]+)(,\s*(?<length>(?!(d|c|ab?|ba?)$)[^,]+))?(,\s*(?<wordLength>(?!(d|c|ab?|ba?)$)[^,]+))?(,\s*(?<rowLength>(?!(d|c|ab?|ba?)$)[^,]+))?(,\s*(?<mode>(d|c|ab?|ba?)))?/i.exec(
        expression
      );
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expression not recognized");
    }

    // Evaluate match groups:
    // All of these parameters can contain expressions
    const address = await this.evaluate(groups.address, frameId);
    const length = groups.wordLength
      ? await this.evaluate(groups.length, frameId)
      : 16;
    const wordLength = groups.wordLength
      ? await this.evaluate(groups.wordLength, frameId)
      : 4;
    const rowLength = groups.rowLength
      ? await this.evaluate(groups.rowLength, frameId)
      : 4;
    const mode = groups.mode ?? "ab";

    if (mode === "d") {
      return await this.disassembleAsVariables(address, length);
    } else if (mode === "c") {
      return await this.disassembleCopperAsVariables(address, length);
    } else {
      return await this.readMemoryAsVariables(
        address,
        length,
        wordLength,
        rowLength,
        mode
      );
    }
  }

  private async readMemoryAsVariables(
    address: number,
    length = 16,
    wordLength = 4,
    rowLength = 4,
    mode = "ab"
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.getMemory(address, length);
    let firstRow = "";
    const variables = new Array<DebugProtocol.Variable>();
    const chunks = chunk(memory.toString(), wordLength * 2);
    let i = 0;
    let rowCount = 0;
    let row = "";
    let nextAddress = address;
    let lineAddress = address;
    while (i < chunks.length) {
      if (rowCount > 0) {
        row += " ";
      }
      row += chunks[i];
      nextAddress += chunks[i].length / 2;
      if (rowCount >= rowLength - 1 || i === chunks.length - 1) {
        if (mode.indexOf("a") >= 0) {
          const asciiText = hexStringToASCII(row.replace(/\s+/g, ""), 2);
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
    return variables;
  }

  public async disassembleAsVariables(
    address: number,
    length: number
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.getMemory(address, length);
    const { instructions } = await disassemble(memory, address);

    return instructions.map(({ instruction, address, instructionBytes }) => ({
      value: (instructionBytes ?? "").padEnd(26) + instruction,
      name: address,
      variablesReference: 0,
    }));
  }

  public async disassembleCopperAsVariables(
    address: number,
    length: number
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.getMemory(address, length);

    return disassembleCopper(memory).map((inst, i) => ({
      value: inst.toString(),
      name: formatAddress(address + i * 4),
      variablesReference: 0,
    }));
  }

  // Location utils

  private async findSourceLine(
    address: number,
    segments: GdbSegment[]
  ): Promise<LineInfo | null> {
    const segment = this.findSegmentContainingAddress(address, segments);
    if (!segment) {
      return null;
    }
    return this.fileInfo.findLineAtLocation(
      segment.id,
      address - segment.address
    );
  }

  private findSegmentContainingAddress(
    address: number,
    segments: GdbSegment[]
  ): GdbSegment | undefined {
    return segments.find(
      (s) => address >= s.address && address < s.address + s.size
    );
  }

  public getAddressForFileEditorLine(
    filePath: string,
    lineNumber: number
  ): Promise<number> {
    return this.disassemblyManager.getAddressForFileEditorLine(
      filePath,
      lineNumber
    );
  }

  public findLocationForLine(
    filename: string,
    lineNumber: number
  ): Promise<SegmentLocation | null> {
    return this.fileInfo.findLocationForLine(filename, lineNumber);
  }
}

export default Program;
