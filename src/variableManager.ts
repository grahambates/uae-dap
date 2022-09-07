import { DebugProtocol } from "@vscode/debugprotocol";
import { Handles, Scope } from "@vscode/debugadapter";
import { parse, eval as expEval } from "expression-eval";

import {
  customRegisterAddresses,
  customRegisterNames,
  CUSTOM_BASE,
  vectors,
} from "./hardware";
import {
  disassemble,
  disassembleCopper,
  DisassemblyManager,
} from "./disassembly";
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
  Custom,
  Vectors,
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
  /** Manager of disassembled code */
  private disassemblyManager: DisassemblyManager;
  /** Lazy loaded constants extracted from current file source */
  private sourceConstants?: Record<string, number>;
  /** Store format options for specific variables */
  private variableFormatterMap = new Map<string, NumberFormat>();

  constructor(
    private gdb: GdbClient,
    private sourceMap: SourceMap,
    private constantResolver?: SourceConstantResolver,
    private memoryFormats: Record<string, MemoryFormat> = {}
  ) {
    this.disassemblyManager = new DisassemblyManager(gdb, this, this.sourceMap);
  }

  /**
   * Read memory from address
   *
   * @param length Length of data to read in bytes
   */
  private async getMemory(address: number, length = 4): Promise<number> {
    // await this.gdb.waitConnected();
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
      new Scope(
        "Custom",
        this.scopes.create({ type: ScopeType.Custom, frameId }),
        true
      ),
      new Scope(
        "Vectors",
        this.scopes.create({ type: ScopeType.Vectors, frameId }),
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
    // await this.gdb.waitConnected();
    if (frameId) {
      // TODO: mutex
      await this.gdb.selectFrame(frameId);
    }
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
      ...customRegisterAddresses,
      ...this.sourceMap.getSymbols(),
      ...sourceConstants,
      ...registerEntries,
    };
  }

  public async getCompletions(
    text: string,
    frameId?: number
  ): Promise<DebugProtocol.CompletionItem[]> {
    // await this.gdb.waitConnected();
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

    if (frameId) {
      // TODO: mutex
      await this.gdb.selectFrame(frameId);
    }
    const registers = await this.gdb.getRegisters();
    const namedRegisters = nameRegisters(registers);
    const sourceConstants = await this.getSourceConstants();

    const vars: DebugProtocol.CompletionItem[] = [
      ...Object.values(customRegisterNames).map((label) => ({
        label,
        detail: "Custom",
      })),
      ...Object.keys(this.sourceMap.getSymbols()).map((label) => ({
        label,
        detail: "Symbol",
      })),
      ...Object.keys(sourceConstants).map((label) => ({
        label,
        detail: "Constant",
      })),
      ...namedRegisters.map((reg) => ({ label: reg.name, detail: "Register" })),
    ];
    return vars.filter((v) => v.label.startsWith(lastWord));
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
    // await this.gdb.waitConnected();

    switch (type) {
      case ScopeType.Registers:
        return this.getRegisterVariables(frameId);
      case ScopeType.Segments:
        return this.getSegmentVariables();
      case ScopeType.Symbols:
        return this.getSymbolVariables();
      case ScopeType.Custom:
        return this.getCustomVariables(frameId);
      case ScopeType.Vectors:
        return this.getVectorVariables();
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
    await this.gdb.selectFrame(frameId); // TODO: mutex
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

  private async getVectorVariables(): Promise<DebugProtocol.Variable[]> {
    // await this.gdb.waitConnected();
    const memory = await this.gdb.readMemory(0, 0xc0);
    const chunks = chunk(memory.toString(), 8).map((chunk) =>
      parseInt(chunk, 16)
    );

    return vectors
      .map((name, i) => {
        if (!name) return;
        let value = this.formatVariable(
          name,
          chunks[i],
          NumberFormat.HEXADECIMAL,
          4
        );
        const offset = this.symbolOffset(chunks[i]);
        if (offset) {
          value += ` (${offset})`;
        }
        return {
          name: "0x" + (i * 4).toString(16).padStart(2, "0") + " " + name,
          value,
          variablesReference: 0,
          memoryReference: (i * 4).toString(16),
        };
      })
      .filter(Boolean) as DebugProtocol.Variable[];
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

  private async getCustomVariables(
    frameId: number
  ): Promise<DebugProtocol.Variable[]> {
    // Read memory starting at $dff000 and chunk into words
    // await this.gdb.waitConnected();
    const memory = await this.gdb.readMemory(CUSTOM_BASE, 0x1fe);
    const chunks = chunk(memory.toString(), 4);

    // Unwanted / duplicate registers to skip
    const ignorenames = [
      "RESERVED",
      // Duplicate {REGNAME}R/{REGNAME}W - Just show the read value
      "HHPOSW",
      "VHPOSW",
      "VPOSW",
      // Duplicate {REGNAME}/{REGNAME}R - emulator is able to read from the actual register
      "ADKCONR",
      "DMACONR",
      "DSKDATR",
      "INTENAR",
      "POTGOR",
      "SERDATR",
    ];

    // Build key/value map of all custom register variables
    const values = chunks.reduce<Record<string, string>>(
      (acc, value, index) => {
        const address = index * 2 + CUSTOM_BASE;
        const name = customRegisterNames[address];
        if (name && !ignorenames.includes(name)) {
          acc[name] = value;
        }
        return acc;
      },
      {}
    );

    // Fields for registers which contain values in specific bytes ranges:
    const fields: Record<string, number> = {
      ADKCON: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BEAMCON0: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BLTSIZE: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BPLCON0: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BPLCON1: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BPLCON2: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BPLCON3: this.scopes.create({ type: ScopeType.Custom, frameId }),
      BPLCON4: this.scopes.create({ type: ScopeType.Custom, frameId }),
      CLXCON: this.scopes.create({ type: ScopeType.Custom, frameId }),
      CLXCON2: this.scopes.create({ type: ScopeType.Custom, frameId }),
      COPCON: this.scopes.create({ type: ScopeType.Custom, frameId }),
      DDFSTRT: this.scopes.create({ type: ScopeType.Custom, frameId }),
      DDFSTOP: this.scopes.create({ type: ScopeType.Custom, frameId }),
      DIWSTRT: this.scopes.create({ type: ScopeType.Custom, frameId }),
      DIWSTOP: this.scopes.create({ type: ScopeType.Custom, frameId }),
      DMACON: this.scopes.create({ type: ScopeType.Custom, frameId }),
      INTENA: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR0POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR0CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR1POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR1CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR2POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR2CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR3POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR3CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR4POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR4CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR5POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR5CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR6POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR6CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR7POS: this.scopes.create({ type: ScopeType.Custom, frameId }),
      SPR7CTL: this.scopes.create({ type: ScopeType.Custom, frameId }),
    };

    this.referencedVariables.set(fields.ADKCON, [
      this.byteReg(values.ADKCON, "PRECOMP", 14, 13),
      this.boolReg(values.ADKCON, "MFMPREC", 12),
      this.boolReg(values.ADKCON, "UARTBRK", 11),
      this.boolReg(values.ADKCON, "WORDSYNC", 10),
      this.boolReg(values.ADKCON, "MSBSYNC", 9),
      this.boolReg(values.ADKCON, "FAST", 8),
      this.boolReg(values.ADKCON, "USE3PN", 7),
      this.boolReg(values.ADKCON, "USE2P3", 6),
      this.boolReg(values.ADKCON, "USE1P2", 5),
      this.boolReg(values.ADKCON, "USE0P1", 4),
      this.boolReg(values.ADKCON, "USE3VN", 3),
      this.boolReg(values.ADKCON, "USE2V3", 2),
      this.boolReg(values.ADKCON, "USE1V2", 1),
      this.boolReg(values.ADKCON, "USE0V1", 0),
    ]);
    this.referencedVariables.set(fields.BEAMCON0, [
      this.boolReg(values.BEAMCON0, "HARDDIS", 14),
      this.boolReg(values.BEAMCON0, "LPENDIS", 13),
      this.boolReg(values.BEAMCON0, "VARVBEN", 12),
      this.boolReg(values.BEAMCON0, "LOLDIS", 11),
      this.boolReg(values.BEAMCON0, "CSCBEN", 10),
      this.boolReg(values.BEAMCON0, "VARVSYEN", 9),
      this.boolReg(values.BEAMCON0, "VARHSYEN", 8),
      this.boolReg(values.BEAMCON0, "VARBEAMEN", 7),
      this.boolReg(values.BEAMCON0, "DUAL", 6),
      this.boolReg(values.BEAMCON0, "PAL", 5),
      this.boolReg(values.BEAMCON0, "VARCSYEN", 4),
      this.boolReg(values.BEAMCON0, "CSYTRUE", 2),
      this.boolReg(values.BEAMCON0, "VSYTRUE", 1),
      this.boolReg(values.BEAMCON0, "HSYTRUE", 0),
    ]);
    this.referencedVariables.set(fields.BLTSIZE, [
      this.wordReg(values.BLTSIZE, "H", 15, 6),
      this.byteReg(values.BLTSIZE, "W", 5, 0),
    ]);
    this.referencedVariables.set(fields.BPLCON0, [
      this.boolReg(values.BPLCON0, "HIRES", 15),
      this.byteReg(values.BPLCON0, "BPU", 14, 12),
      this.boolReg(values.BPLCON0, "HOMOD", 11),
      this.boolReg(values.BPLCON0, "DBLPF", 10),
      this.boolReg(values.BPLCON0, "COLOR", 9),
      this.boolReg(values.BPLCON0, "GAUD", 8),
      this.boolReg(values.BPLCON0, "UHRES", 7),
      this.boolReg(values.BPLCON0, "SHRES", 6),
      this.boolReg(values.BPLCON0, "BYPASS", 5),
      this.boolReg(values.BPLCON0, "BPU2", 4), // TODO: combine?
      this.boolReg(values.BPLCON0, "LPEN", 3),
      this.boolReg(values.BPLCON0, "LACE", 2),
      this.boolReg(values.BPLCON0, "ERSY", 1),
      this.boolReg(values.BPLCON0, "ECSENA", 0),
    ]);
    this.referencedVariables.set(fields.BPLCON1, [
      // TODO: upper bytes
      this.byteReg(values.BPLCON1, "PF2H", 7, 4),
      this.byteReg(values.BPLCON1, "PF1H", 3, 0),
    ]);
    this.referencedVariables.set(fields.BPLCON2, [
      this.byteReg(values.BPLCON2, "ZDBPSEL0", 14, 12),
      this.boolReg(values.BPLCON2, "ZDBPEN", 11),
      this.boolReg(values.BPLCON2, "ZDCTEN", 10),
      this.boolReg(values.BPLCON2, "KILLEHB", 9),
      this.boolReg(values.BPLCON2, "RDRAM", 8),
      this.boolReg(values.BPLCON2, "SOGEN", 7),
      this.boolReg(values.BPLCON2, "PF2PRI", 6),
      this.byteReg(values.BPLCON2, "PF2P", 4, 3),
      this.byteReg(values.BPLCON2, "PF1P", 2, 0),
    ]);
    this.referencedVariables.set(fields.BPLCON3, [
      this.byteReg(values.BPLCON3, "BANK", 15, 13),
      this.byteReg(values.BPLCON3, "PF2OF", 12, 10),
      this.boolReg(values.BPLCON3, "LOCT", 9),
      this.byteReg(values.BPLCON3, "SPRES", 7, 6),
      this.boolReg(values.BPLCON3, "BRDRBLNK", 5),
      this.boolReg(values.BPLCON3, "BRDNTRAN", 4),
      this.boolReg(values.BPLCON3, "ZDCLKEN", 2),
      this.boolReg(values.BPLCON3, "BRDSPRT", 1),
      this.boolReg(values.BPLCON3, "EXTBLKEN", 0),
    ]);
    this.referencedVariables.set(fields.BPLCON4, [
      this.byteReg(values.BPLCON4, "BPLAM", 15, 8),
      this.byteReg(values.BPLCON4, "ESPRM", 7, 4), // << 4
      this.byteReg(values.BPLCON4, "OSPRM", 3, 0),
    ]);
    this.referencedVariables.set(fields.CLXCON, [
      this.boolReg(values.CLXCON, "ENSP7", 15),
      this.boolReg(values.CLXCON, "ENSP5", 14),
      this.boolReg(values.CLXCON, "ENSP3", 13),
      this.boolReg(values.CLXCON, "ENSP1", 12),
      this.boolReg(values.CLXCON, "ENBP6", 11),
      this.boolReg(values.CLXCON, "ENBP5", 10),
      this.boolReg(values.CLXCON, "ENBP4", 9),
      this.boolReg(values.CLXCON, "ENBP3", 8),
      this.boolReg(values.CLXCON, "ENBP2", 7),
      this.boolReg(values.CLXCON, "ENBP1", 6),
      this.boolReg(values.CLXCON, "MVBP6", 5),
      this.boolReg(values.CLXCON, "MVBP5", 4),
      this.boolReg(values.CLXCON, "MVBP4", 3),
      this.boolReg(values.CLXCON, "MVBP3", 2),
      this.boolReg(values.CLXCON, "MVBP2", 1),
      this.boolReg(values.CLXCON, "MVBP1", 0),
    ]);
    this.referencedVariables.set(fields.CLXCON2, [
      this.boolReg(values.CLXCON2, "ENBP8", 7),
      this.boolReg(values.CLXCON2, "ENBP7", 6),
      this.boolReg(values.CLXCON2, "MVBP8", 1),
      this.boolReg(values.CLXCON2, "MVBP7", 0),
    ]);
    this.referencedVariables.set(fields.COPCON, [
      this.boolReg(values.COPCON, "CDANG", 1),
    ]);
    this.referencedVariables.set(fields.DDFSTRT, [
      this.wordReg(values.DDFSTRT, "H", 8, 0),
    ]);
    this.referencedVariables.set(fields.DDFSTRT, [
      this.wordReg(values.DDFSTOP, "H", 8, 0),
    ]);
    this.referencedVariables.set(fields.DIWSTRT, [
      this.byteReg(values.DIWSTRT, "V", 15, 8),
      this.byteReg(values.DIWSTRT, "H", 7, 0), // << 2
    ]);
    this.referencedVariables.set(fields.DIWSTOP, [
      this.byteReg(values.DIWSTOP, "V", 15, 8),
      this.byteReg(values.DIWSTOP, "H", 7, 0), // << 2
    ]);
    this.referencedVariables.set(fields.DMACON, [
      this.boolReg(values.DMACON, "BBUSY", 14),
      this.boolReg(values.DMACON, "BZERO", 13),
      this.boolReg(values.DMACON, "BLTPRI", 10),
      this.boolReg(values.DMACON, "DMAEN", 9),
      this.boolReg(values.DMACON, "BPLEN", 8),
      this.boolReg(values.DMACON, "COPEN", 7),
      this.boolReg(values.DMACON, "BLTEN", 6),
      this.boolReg(values.DMACON, "SPREN", 5),
      this.boolReg(values.DMACON, "DSKEN", 4),
      this.boolReg(values.DMACON, "AUD3EN", 3),
      this.boolReg(values.DMACON, "AUD2EN", 2),
      this.boolReg(values.DMACON, "AUD1EN", 1),
      this.boolReg(values.DMACON, "AUD0EN", 0),
    ]);
    this.referencedVariables.set(fields.INTENA, [
      this.boolReg(values.INTENA, "INTEN", 14),
      this.boolReg(values.INTENA, "EXTER", 13),
      this.boolReg(values.INTENA, "DSKSYN", 12),
      this.boolReg(values.INTENA, "RBF", 11),
      this.boolReg(values.INTENA, "AUD3", 10),
      this.boolReg(values.INTENA, "AUD2", 9),
      this.boolReg(values.INTENA, "AUD1", 8),
      this.boolReg(values.INTENA, "AUD0", 7),
      this.boolReg(values.INTENA, "BLIT", 6),
      this.boolReg(values.INTENA, "VERTB", 5),
      this.boolReg(values.INTENA, "COPER", 4),
      this.boolReg(values.INTENA, "PORTS", 3),
      this.boolReg(values.INTENA, "SOFT", 2),
      this.boolReg(values.INTENA, "DSKBLK", 1),
      this.boolReg(values.INTENA, "TBE", 0),
    ]);
    for (let i = 0; i < 8; i++) {
      const pos = `SPR${i}POS`;
      this.referencedVariables.set(fields[pos], [
        this.byteReg(values[pos], "SV", 15, 8),
        this.byteReg(values[pos], "SH", 7, 0), // << 1
      ]);
      const ctl = `SPR${i}CTL`;
      this.referencedVariables.set(fields[ctl], [
        this.byteReg(values[ctl], "EV", 15, 8),
        this.boolReg(values[ctl], "ATT", 7),
        this.boolReg(values[ctl], "SV8", 2),
        this.boolReg(values[ctl], "EV8", 1),
        this.boolReg(values[ctl], "SH0", 0),
      ]);
    }

    // Convert values to variable objects
    const variables: Record<string, DebugProtocol.Variable> = {};
    for (let key in values) {
      const address = customRegisterAddresses[key];
      if (!address) continue;

      const memoryReference = address.toString(16);
      let value: string | undefined;

      // Add fields if defined
      const variablesReference = fields[key] ?? 0;

      const isHigh = key.endsWith("H");
      const isLow = key.endsWith("L");
      const lowKey = key.replace(/H$/, "L");
      const highKey = key.replace(/L$/, "H");

      if (isHigh && values[lowKey]) {
        // Combine high/low words into single longword value
        const num = parseInt(values[key] + values[lowKey], 16);
        key = key.replace(/H$/, "");
        value = this.formatVariable(key, num, NumberFormat.HEXADECIMAL, 4);
      } else if (!(isLow && values[highKey])) {
        // Ignore keys for low register which will have been combined
        const num = parseInt(values[key], 16);
        const format = key.match(/[FL]WM$/)
          ? NumberFormat.BINARY // Binary for masks
          : NumberFormat.HEXADECIMAL;
        value = this.formatVariable(key, num, format, 2);
      }

      if (value) {
        variables[key] = {
          name: key,
          value,
          type: variablesReference ? "array" : "register",
          variablesReference,
          memoryReference,
        };
      }
    }

    // Simple registers with no nesting
    const singleRegs: DebugProtocol.Variable[] = Object.keys(variables)
      .filter(
        (key) => !key.match(/^((AUD|BPL|BPLCON|COLOR|SPR)[0-9]|BLT[A-D])/)
      )
      .map((name) => variables[name]);

    // Group numbered registers/sets as arrays with their own variablesReference:

    // Get all variables starting with a prefix and unprefix the name property
    const getPrefixed = (prefix: RegExp, replace: string | RegExp = prefix) =>
      Object.keys(variables)
        .filter((key) => key.match(prefix))
        .map((name) => ({
          ...variables[name],
          name: name.replace(replace, ""),
        }));

    // COLORXX
    const colors = getPrefixed(/^COLOR\d/, "COLOR");
    const colorsScope = this.scopes.create({ type: ScopeType.Custom, frameId });
    this.referencedVariables.set(colorsScope, colors);

    // BPLCONX
    const bplCons = getPrefixed(/^BPLCON\d/, "BPLCON");
    const bplConScope = this.scopes.create({ type: ScopeType.Custom, frameId });
    this.referencedVariables.set(bplConScope, bplCons);

    // BLTX
    const blt: DebugProtocol.Variable[] = [];
    for (const i of ["A", "B", "C", "D"]) {
      const vars = getPrefixed(new RegExp("BLT" + i));
      const scope = this.scopes.create({ type: ScopeType.Custom, frameId });
      this.referencedVariables.set(scope, vars);
      blt.push({
        name: i,
        type: "array",
        value: "Channel " + i,
        variablesReference: scope,
      });
    }
    const bltScope = this.scopes.create({ type: ScopeType.Custom, frameId });
    this.referencedVariables.set(bltScope, blt);

    // AUDX
    const aud: DebugProtocol.Variable[] = [];
    for (let i = 0; i < 4; i++) {
      const vars = getPrefixed(new RegExp("AUD" + i));
      const scope = this.scopes.create({ type: ScopeType.Custom, frameId });
      this.referencedVariables.set(scope, vars);
      aud.push({
        name: i.toString(),
        type: "array",
        value: "Channel " + i,
        variablesReference: scope,
      });
    }
    const audScope = this.scopes.create({ type: ScopeType.Custom, frameId });
    this.referencedVariables.set(audScope, aud);

    // BPLX
    const bpl: DebugProtocol.Variable[] = [];
    for (let i = 1; i < 9; i++) {
      const vars = getPrefixed(new RegExp("BPL" + i));
      const scope = this.scopes.create({ type: ScopeType.Custom, frameId });
      this.referencedVariables.set(scope, vars);
      bpl.push({
        name: i.toString(),
        type: "array",
        value: "Bitplane " + i,
        variablesReference: scope,
      });
    }
    const bplScope = this.scopes.create({ type: ScopeType.Custom, frameId });
    this.referencedVariables.set(bplScope, bpl);

    // SPRX
    const spr: DebugProtocol.Variable[] = [];
    for (let i = 0; i < 8; i++) {
      const vars = getPrefixed(new RegExp("SPR" + i));
      const scope = this.scopes.create({ type: ScopeType.Custom, frameId });
      this.referencedVariables.set(scope, vars);
      spr.push({
        name: i.toString(),
        type: "array",
        value: "Sprite " + i,
        variablesReference: scope,
      });
    }
    const sprScope = this.scopes.create({ type: ScopeType.Custom, frameId });
    this.referencedVariables.set(sprScope, spr);

    return [
      ...singleRegs,
      // Base variables for groups
      {
        name: "COLORXX",
        type: "array",
        value: "Colors",
        variablesReference: colorsScope,
      },
      {
        name: "AUDX",
        type: "array",
        value: "Audio channels",
        variablesReference: audScope,
      },
      {
        name: "BPLCONX",
        type: "array",
        value: "Bitplane control",
        variablesReference: bplConScope,
      },
      {
        name: "BLTX",
        type: "array",
        value: "Blitter channels",
        variablesReference: bltScope,
      },
      {
        name: "BPLX",
        type: "array",
        value: "Bitplanes",
        variablesReference: bplScope,
      },
      {
        name: "SPRX",
        type: "array",
        value: "Sprites",
        variablesReference: sprScope,
      },
    ].sort((a, b) => (a.name > b.name ? 1 : -1));
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
    const numValue = await this.evaluate(value);
    if (typeof numValue !== "number") {
      throw new Error("Value is not numeric");
    }
    switch (scopeRef?.type) {
      case ScopeType.Registers:
        await this.gdb.setRegister(
          getRegisterIndex(name),
          numValue.toString(16)
        );
        return this.formatVariable(name, numValue, NumberFormat.HEXADECIMAL, 4);

      case ScopeType.Vectors: {
        const [addr] = name.split(" ");
        await this.gdb.writeMemory(
          parseInt(addr, 16),
          numValue.toString(16).padStart(8, "0")
        );
        return this.formatVariable(name, numValue, NumberFormat.HEXADECIMAL, 4);
      }

      case ScopeType.Custom: {
        // Find address of register:
        // Check global register list. May need a a suffix for high word if combined.
        let address =
          customRegisterAddresses[name] || customRegisterAddresses[name + "H"];
        // Check fields in scope for memoryReference
        if (!address) {
          const v = this.referencedVariables
            .get(variablesReference)
            ?.find((n) => n.name === name);
          if (v?.memoryReference) {
            address = parseInt(v.memoryReference, 16);
          } else {
            throw new Error("Address not found");
          }
        }

        // Check size to write - longword for combined pointer addresses
        const isLong = name.endsWith("PT") || name.endsWith("LC");
        const size = isLong ? 8 : 4;

        await this.gdb.writeMemory(
          address,
          numValue.toString(16).padStart(size, "0")
        );

        return this.formatVariable(
          name,
          numValue,
          NumberFormat.HEXADECIMAL,
          size
        );
      }

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
    // await this.gdb.waitConnected();
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
      case "c":
        variables = await this.disassembleCopperCommand(expression, frameId);
        break;
      case "h":
      case "H":
      case "?":
        return;
      default:
        if (isRegister) {
          if (frameId) {
            await this.gdb.selectFrame(frameId);
          }
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

  private async disassembleCopperCommand(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    const matches = /c\s*(?<address>[^,]+)(,\s*(?<length>[^,]+))?/i.exec(
      expression
    );
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expected syntax: c address[,size=16]");
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
    return this.disassembleCopperAsVariables(address, length);
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

  private async disassembleCopperAsVariables(
    address: number,
    length: number
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.readMemory(address, length);

    return disassembleCopper(memory).map((inst, i) => ({
      value: inst.toString(),
      name: formatAddress(address + i * 4),
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
