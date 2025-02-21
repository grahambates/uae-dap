import { DebugProtocol } from "@vscode/debugprotocol";
import { Handles, logger, Scope } from "@vscode/debugadapter";
import { parse, eval as expEval } from "expression-eval";

import { disassemble } from "./disassembly";
import { GdbClient } from "./gdbClient";
import {
  bitValue,
  chunk,
  compareStringsLowerCase,
  formatAddress,
  formatNumber,
  hexStringToASCII,
  NumberFormat,
} from "./utils/strings";
import SourceMap from "./sourceMap";
import { getRegisterIndex, nameRegisters } from "./registers";

export enum ScopeType {
  Registers,
  Segments,
  Symbols,
  StatusRegister,
  Expression,
  SourceConstants,
}

export interface ScopeReference {
  type: ScopeType;
  frameId: number;
}

export interface MemoryFormat {
  length: number;
  wordLength?: number;
  rowLength?: number;
  mode?: string;
}

/**
 * Provider to get constants for program sources
 */
export interface SourceConstantResolver {
  /**
   * Get constants defined in the sources
   *
   * @param sourceFiles Array of file paths for source files
   * @returns object containing key/value pairs for
   */
  getSourceConstants(sourceFiles: string[]): Promise<Record<string, number>>;
}

/**
 * Wrapper to interact with running Program
 */
class VariableManager {
  private scopes = new Handles<ScopeReference>();
  /** Variables lookup by handle */
  private referencedVariables = new Map<number, DebugProtocol.Variable[]>();
  /** Lazy loaded constants extracted from current file source */
  private sourceConstants?: Record<string, number>;
  /** Store format options for specific variables */
  private variableFormatterMap = new Map<string, NumberFormat>();

  constructor(
    private gdb: GdbClient,
    private sourceMap: SourceMap,
    private constantResolver?: SourceConstantResolver,
    private memoryFormats: Record<string, MemoryFormat> = {}
  ) {}

  /**
   * Read memory from address
   *
   * @param length Length of data to read in bytes
   */
  private async getMemory(address: number, length = 4): Promise<number> {
    const hex = await this.gdb.readMemory(address, length);
    return parseInt(hex, 16);
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
        "Symbols",
        this.scopes.create({ type: ScopeType.Symbols, frameId }),
        true
      ),
      new Scope(
        "Constants",
        this.scopes.create({ type: ScopeType.SourceConstants, frameId }),
        true
      ),
      new Scope(
        "Segments",
        this.scopes.create({ type: ScopeType.Segments, frameId }),
        true
      ),
    ];
  }

  // Variables:

  /**
   * Get object containing all variables and constants
   */
  public async getVariables(
    frameId?: number
  ): Promise<Record<string, number | Record<string, number>>> {
    return this.gdb.withFrame(frameId, async () => {
      const registers = await this.gdb.getRegisters();
      const namedRegisters = nameRegisters(registers);
      const registerEntries = namedRegisters.reduce<
        Record<string, number | Record<string, number>>
      >((acc, v) => {
        acc[v.name] = v.value;
        // Store size/sign fields in prefixed object
        // The prefix will be stripped out later when evaluating the expression
        if (v.name.match(/^[ad]/i)) {
          acc["__OBJ__" + v.name] = this.registerFields(v.value);
        }
        return acc;
      }, {});
      const sourceConstants = await this.getSourceConstants();

      return {
        //...customRegisterAddresses,
        ...this.sourceMap.getSymbols(),
        ...sourceConstants,
        ...registerEntries,
      };
    });
  }

  public async getCompletions(
    text: string,
    frameId?: number
  ): Promise<DebugProtocol.CompletionItem[]> {
    const words = text.split(/[^\w.]/);
    const lastWord = words.pop();
    if (!lastWord) {
      return [];
    }

    if (lastWord?.includes(".")) {
      const parts = lastWord.split(".");
      const vars: DebugProtocol.CompletionItem[] = [
        { label: "b", detail: "Byte value" },
        { label: "bs", detail: "Byte value signed" },
        { label: "w", detail: "Word value" },
        { label: "ws", detail: "Word value signed" },
        { label: "l", detail: "Longword value" },
        { label: "ls", detail: "LongWord value signed" },
      ];
      return vars.filter((v) => v.label.startsWith(parts[1]));
    }

    const sourceConstants = await this.getSourceConstants();

    return this.gdb.withFrame(frameId, async () => {
      const registers = await this.gdb.getRegisters();
      const namedRegisters = nameRegisters(registers);

      const vars: DebugProtocol.CompletionItem[] = [
        ...Object.keys(this.sourceMap.getSymbols()).map((label) => ({
          label,
          detail: "Symbol",
        })),
        ...Object.keys(sourceConstants).map((label) => ({
          label,
          detail: "Constant",
        })),
        ...namedRegisters.map((reg) => ({
          label: reg.name,
          detail: "Register",
        })),
      ];
      return vars.filter((v) => v.label.startsWith(lastWord));
    });
  }

  private registerFields(value: number) {
    const b = value & 0xff;
    const bs = b >= 0x80 ? b - 0x100 : b;
    const w = value & 0xffff;
    const ws = w >= 0x8000 ? w - 0x10000 : w;
    const l = value & 0xffffffff;
    const ls = l >= 0x80000000 ? l - 0x100000000 : l;
    return { b, bs, w, ws, l, ls };
  }

  /**
   * Lazy load constants from parsed source files
   */
  private async getSourceConstants(): Promise<Record<string, number>> {
    if (this.sourceConstants) {
      return this.sourceConstants;
    }
    const sourceFiles = this.sourceMap.getSourceFiles();
    logger.log(
      "Getting constants from source files: " + sourceFiles.join(", ")
    );
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

    switch (type) {
      case ScopeType.Registers:
        return this.getRegisterVariables(frameId);
      case ScopeType.Segments:
        return this.getSegmentVariables();
      case ScopeType.Symbols:
        return this.getSymbolVariables();
      case ScopeType.SourceConstants:
        return this.getSourceConstantVariables();
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
    return this.gdb.withFrame(frameId, async () => {
      const registers = await this.gdb.getRegisters();
      const namedRegisters = nameRegisters(registers);

      // Stack register properties go in their own variables array to be fetched later by reference
      const sr = namedRegisters
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
      return namedRegisters
        .filter(({ name }) => !name.startsWith("SR_"))
        .map(({ name, value }) => {
          let formatted = this.formatVariable(
            name,
            value,
            NumberFormat.HEXADECIMAL,
            4
          );
          // Add offset to address registers
          if (name.startsWith("a") || name === "pc") {
            const offset = this.symbolOffset(value);
            if (offset) {
              formatted += ` (${offset})`;
            }
          }

          let variablesReference = 0;

          if (name.startsWith("sr")) {
            // Reference to stack register fields
            variablesReference = srScope;
          } else if (name !== "pc") {
            // Size / sign variants as fields
            const fields = this.registerFields(value);
            const fieldVars: DebugProtocol.Variable[] = [
              {
                name: "b",
                type: "register",
                value: this.formatVariable(
                  "b",
                  fields.b,
                  NumberFormat.HEXADECIMAL,
                  1
                ),
                variablesReference: 0,
              },
              {
                name: "bs",
                type: "register",
                value: this.formatVariable(
                  "bs",
                  fields.bs,
                  NumberFormat.HEXADECIMAL,
                  1
                ),
                variablesReference: 0,
              },
              {
                name: "w",
                type: "register",
                value: this.formatVariable(
                  "w",
                  fields.w,
                  NumberFormat.HEXADECIMAL,
                  2
                ),
                variablesReference: 0,
              },
              {
                name: "ws",
                type: "register",
                value: this.formatVariable(
                  "ws",
                  fields.ws,
                  NumberFormat.HEXADECIMAL,
                  2
                ),
                variablesReference: 0,
              },
              {
                name: "l",
                type: "register",
                value: this.formatVariable(
                  "l",
                  fields.l,
                  NumberFormat.HEXADECIMAL,
                  4
                ),
                variablesReference: 0,
              },
              {
                name: "ls",
                type: "register",
                value: this.formatVariable(
                  "ls",
                  fields.ls,
                  NumberFormat.HEXADECIMAL,
                  4
                ),
                variablesReference: 0,
              },
            ];
            variablesReference = this.scopes.create({
              type: ScopeType.Registers,
              frameId,
            });
            this.referencedVariables.set(variablesReference, fieldVars);
          }

          return {
            name,
            type: "register",
            value: formatted,
            variablesReference,
            memoryReference: value.toString(),
          };
        });
    });
  }

  private getSegmentVariables(): DebugProtocol.Variable[] {
    const segments = this.sourceMap.getSegmentsInfo();
    return segments.map((s) => {
      const name = s.name;
      return {
        name,
        type: "segment",
        value: `${this.formatVariable(
          name,
          s.address,
          NumberFormat.HEXADECIMAL,
          4
        )} {size:${s.size}}`,
        variablesReference: 0,
        memoryReference: s.address.toString(),
      };
    });
  }

  private getSymbolVariables(): DebugProtocol.Variable[] {
    const symbols = this.sourceMap.getSymbols();
    return Object.keys(symbols)
      .sort(compareStringsLowerCase)
      .map((name) => ({
        name,
        type: "symbol",
        value: this.formatVariable(
          name,
          symbols[name],
          NumberFormat.HEXADECIMAL,
          4
        ),
        variablesReference: 0,
        memoryReference: symbols[name].toString(),
      }));
  }

  private async getSourceConstantVariables(): Promise<
    DebugProtocol.Variable[]
  > {
    const consts = await this.getSourceConstants();
    return Object.keys(consts).map((name) => ({
      name,
      value: this.formatVariable(name, consts[name], NumberFormat.HEXADECIMAL),
      variablesReference: 0,
    }));
  }

  /**
   * Set the value of a variable
   *
   * Only registers are supported.
   */
  public async setVariable(
    variablesReference: number,
    name: string,
    value: string
  ): Promise<string> {
    const scopeRef = this.scopes.get(variablesReference);
    let numValue = await this.evaluate(value);
    if (typeof numValue !== "number") {
      throw new Error("Value is not numeric");
    }
    switch (scopeRef?.type) {
      case ScopeType.Registers:
        if (numValue < 0) {
          numValue += 0x100000000;
        }
        if (Math.abs(numValue) > 0x100000000) {
          throw new Error("Register value out of range");
        }
        await this.gdb.setRegister(getRegisterIndex(name), numValue);
        return this.formatVariable(name, numValue, NumberFormat.HEXADECIMAL, 4);

      default:
        throw new Error("This variable cannot be set");
    }
  }

  // Variable formatting:

  /**
   * Format a variable as a string in the preferred NumberFormat
   */
  public formatVariable(
    variableName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any,
    defaultFormat: NumberFormat = NumberFormat.HEXADECIMAL,
    minBytes = 0
  ): string {
    if (typeof value !== "number") {
      return String(value);
    }
    const format = this.variableFormatterMap.get(variableName) ?? defaultFormat;
    return formatNumber(value, format, minBytes);
  }

  /**
   * Set the preferred format for a specific variable
   */
  public setVariableFormat(variableName: string, format: NumberFormat) {
    this.variableFormatterMap.set(variableName, format);
  }

  // Expressions:

  /**
   * Evaluate an expression or custom command
   *
   * @returns Single value or array
   */
  public async evaluateExpression({
    expression,
    frameId,
    context,
  }: DebugProtocol.EvaluateArguments): Promise<
    | {
        result: string;
        type?: string;
        variablesReference: number;
      }
    | undefined
  > {
    let variables: DebugProtocol.Variable[] | undefined;
    let result: string | undefined;

    const { length, wordLength, rowLength } = this.getMemoryFormat(context);

    // Find expression type:
    const isRegister = expression.match(/^([ad][0-7]|pc|sr)$/i) !== null;
    const symbols = this.sourceMap.getSymbols();
    const isSymbol = symbols[expression] !== undefined;

    const commandMatch = expression.match(/([mdcph?])(\s|$)/i);
    const command = commandMatch?.[1];

    switch (command) {
      case "m":
        variables = await this.dumpMemoryCommand(expression, frameId);
        break;
      case "M":
        variables = await this.writeMemoryCommand(expression, frameId);
        break;
      case "d":
        variables = await this.disassembleCommand(expression, frameId);
        break;
      case "h":
      case "H":
      case "?":
        return;
      default:
        if (isRegister) {
          await this.gdb.withFrame(frameId, async () => {
            const address = await this.gdb.getRegister(
              getRegisterIndex(expression)
            );
            if (expression.startsWith("a") && context === "watch") {
              variables = await this.readMemoryAsVariables(
                address,
                length,
                wordLength,
                rowLength
              );
            } else {
              result = this.formatVariable(
                expression,
                address,
                NumberFormat.HEXADECIMAL,
                4
              );
            }
          });
        } else if (isSymbol && (context === "watch" || context === "hover")) {
          const address = symbols[expression];
          variables = await this.readMemoryAsVariables(
            address,
            length,
            wordLength,
            rowLength
          );
        } else {
          // Evaluate
          const value = await this.evaluate(expression, frameId);
          result = this.formatVariable(
            expression,
            value,
            NumberFormat.HEXADECIMAL
          );
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

  protected getMemoryFormat(context?: string): MemoryFormat {
    const defaultFormat = {
      length: 24,
      wordLength: 2,
    };
    return context
      ? this.memoryFormats[context] ?? defaultFormat
      : defaultFormat;
  }

  /**
   * Evaluate simple expression to numeric value
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async evaluate(expression: string, frameIndex?: number): Promise<any> {
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

    // Add prefix when referencing register fields
    exp = exp.replace(/([ad][0-7]+)\./i, "__OBJ__$1.");

    // ${expression} is replaced with expressio for backwards compatiblity
    exp = exp.replace(/\$\{([^}]+)\}/, "$1");

    const variables = await this.getVariables(frameIndex);

    // Memory references:
    // Numeric value at memory address

    // Legacy syntax:
    // #{expression}
    const legacyMemMatches = exp.matchAll(/#\{(?<address>[^},]+)\}/gi);
    for (const match of legacyMemMatches) {
      const { address } = match.groups ?? {};
      const addressNum = await this.evaluate(address, frameIndex);
      if (typeof addressNum !== "number") {
        throw new Error("address is not numeric");
      }
      const value = await this.getMemory(addressNum);
      exp = exp.replace(match[0], value.toString());
    }

    // @(expression[,size=4])
    // @s(expression[,size=4]) - signed
    const memMatches = exp.matchAll(
      /@(?<sign>[su])?\((?<address>[^),]+)(,\s*(?<length>\d))?\)/gi
    );

    for (const match of memMatches) {
      const { address, length, sign } = match.groups ?? {};
      const addressNum = await this.evaluate(address, frameIndex);
      if (typeof addressNum !== "number") {
        throw new Error("address is not numeric");
      }
      const lengthNum = length ? parseInt(length) : 4;
      let value = await this.getMemory(addressNum, lengthNum);
      if (sign === "s" || sign === "S") {
        const range = Math.pow(2, lengthNum * 8);
        if (value >= range / 2) {
          value -= range;
        }
      }
      exp = exp.replace(match[0], value.toString());
    }

    // Evaluate expression
    return expEval(parse(exp), variables);
  }

  private async writeMemoryCommand(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    const matches =
      /M\s*(?<addr>[{}$#0-9a-z_]+)\s*=\s*(?<data>[0-9a-z_]+)/i.exec(expression);
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expected syntax: M address=bytes");
    }
    const address = await this.evaluate(groups.addr, frameId);
    if (typeof address !== "number") {
      throw new Error("address is not numeric");
    }
    await this.gdb.writeMemory(address, groups.data);
    return this.readMemoryAsVariables(address, groups.data.length / 2);
  }

  private async dumpMemoryCommand(
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
      throw new Error(
        "Expected syntax: m address[,size=16,wordSizeInBytes=4,rowSizeInWords=4][,ab]"
      );
    }

    // Evaluate match groups:
    // All of these parameters can contain expressions
    const address = await this.evaluate(groups.address, frameId);
    if (typeof address !== "number") {
      throw new Error("address is not numeric");
    }
    const length = groups.length
      ? await this.evaluate(groups.length, frameId)
      : 16;
    if (typeof length !== "number") {
      throw new Error("length is not numeric");
    }
    const wordLength = groups.wordLength
      ? await this.evaluate(groups.wordLength, frameId)
      : 4;
    if (typeof wordLength !== "number") {
      throw new Error("wordLength is not numeric");
    }
    const rowLength = groups.rowLength
      ? await this.evaluate(groups.rowLength, frameId)
      : 4;
    if (typeof rowLength !== "number") {
      throw new Error("rowLength is not numeric");
    }
    const mode = groups.mode ?? "ab";

    if (mode === "d") {
      return await this.disassembleAsVariables(address, length);
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

  private async disassembleCommand(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    const matches = /d\s*(?<address>[^,]+)(,\s*(?<length>[^,]+))?/i.exec(
      expression
    );
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expected syntax: d address[,size=16]");
    }
    const address = await this.evaluate(groups.address, frameId);
    if (typeof address !== "number") {
      throw new Error("address is not numeric");
    }
    const length = groups.length
      ? await this.evaluate(groups.length, frameId)
      : 16;
    if (typeof length !== "number") {
      throw new Error("length is not numeric");
    }
    return this.disassembleAsVariables(address, length);
  }

  private async readMemoryAsVariables(
    address: number,
    length = 16,
    wordLength = 4,
    rowLength = 4,
    mode = "ab"
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.readMemory(address, length);
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

  private async disassembleAsVariables(
    address: number,
    length: number
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.readMemory(address, length);
    const { instructions } = await disassemble(memory, address);

    return instructions.map(({ instruction, address, instructionBytes }) => ({
      value: (instructionBytes ?? "").padEnd(26) + instruction,
      name: address,
      variablesReference: 0,
    }));
  }

  // Location utils

  // Helpers to build variables from byte ranges:

  private boolReg(
    value: string,
    name: string,
    bit: number
  ): DebugProtocol.Variable {
    return {
      name,
      type: "register",
      value: bitValue(parseInt(value, 16), bit) ? "1" : "0",
      variablesReference: 0,
    };
  }

  private byteReg(
    value: string,
    name: string,
    hi: number,
    lo: number
  ): DebugProtocol.Variable {
    return {
      name,
      type: "register",
      value: this.formatVariable(
        name,
        bitValue(parseInt(value, 16), hi, lo),
        NumberFormat.HEXADECIMAL,
        1
      ),
      variablesReference: 0,
    };
  }

  private wordReg(
    value: string,
    name: string,
    hi: number,
    lo: number
  ): DebugProtocol.Variable {
    return {
      name,
      type: "register",
      value: this.formatVariable(
        name,
        bitValue(parseInt(value, 16), hi, lo),
        NumberFormat.HEXADECIMAL,
        2
      ),
      variablesReference: 0,
    };
  }

  /**
   * Get symbol name and offset for address
   */
  private symbolOffset(address: number): string | null {
    let symbolName;
    let symbolAddress;
    const symbols = this.sourceMap.getSymbols();
    for (const name of Object.keys(symbols)) {
      const value = symbols[name];
      if (value > address) break;
      symbolName = name;
      symbolAddress = value;
    }
    if (!symbolName || !symbolAddress) {
      return null;
    }
    const offset = address - symbolAddress;
    if (offset > 1024) {
      return null;
    }
    if (offset > 0) {
      symbolName += "+" + offset;
    }
    return symbolName;
  }
}

export default VariableManager;
