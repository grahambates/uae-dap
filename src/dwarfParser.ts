/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-constant-condition */

// ELF and DWARF type definitions
export interface ELFSectionHeader {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
}

export interface CompilationUnit {
  length: number;
  version: number;
  abbrevOffset: number;
  addressSize: number;
  offset: number;
  dies: DebugInfoEntry[];
}

export interface DebugInfoEntry {
  abbrevCode: number;
  tag: number | undefined;
  attributes: DWARFAttribute[];
  size: number;
  children: DebugInfoEntry[];
}

export interface DWARFAttribute {
  name: number;
  form: number;
  value: any;
}

export interface AbbreviationEntry {
  code: number;
  tag: number;
  hasChildren: boolean;
  attributes: Array<{ name: number; form: number }>;
}

export interface FileEntry {
  name: string;
  directoryIndex: number;
  modificationTime: number;
  size: number;
}

export interface LineNumberProgram {
  totalLength: number;
  version: number;
  headerLength: number;
  minimumInstructionLength: number;
  defaultIsStmt: boolean;
  lineBase: number;
  lineRange: number;
  opcodeBase: number;
  standardOpcodeLengths: number[];
  includeDirectories: string[];
  fileNames: FileEntry[];
  instructions: LineNumberInstruction[];
}

export interface LineNumberInstruction {
  opcode: number;
  size: number;
  type?: "extended" | "standard" | "special";
  extended?: boolean;
  length?: number;
  extOpcode?: number;
  address?: number;
  fileName?: string;
  name?: string;
  advance?: number;
  file?: number;
  column?: number;
  addressAdvance?: number;
  lineAdvance?: number;
}

export interface LineNumberState {
  address: number;
  file: number;
  line: number;
  column: number;
  isStmt: boolean;
  basicBlock: boolean;
  endSequence: boolean;
}

export interface LEB128Result {
  value: number;
  size: number;
}

export interface StringResult {
  value: string;
  size: number;
}

export interface ELFSymbol {
  name: string;
  value: number;
  size: number;
  type: number;
  bind: number;
  visibility: number;
  sectionIndex: number;
}

export interface SourceMapEntry {
  address: number;
  binaryOffset: number;
  sourceFile: string;
  lineNumber: number;
  column: number;
  isStatement: boolean;
}

export interface DWARFData {
  sections: Map<string, ELFSectionHeader>;
  compilationUnits: CompilationUnit[];
  lineNumberPrograms: LineNumberProgram[];
  debugStrings: Uint8Array | undefined;
  abbreviationTables: Map<number, AbbreviationEntry[]>;
  elfSymbols: ELFSymbol[];
  is64bit: boolean;
  isLittleEndian: boolean;
}

// DWARF constants
export const DW_TAG = {
  compile_unit: 0x11,
  subprogram: 0x2e,
  variable: 0x34,
  base_type: 0x24,
  pointer_type: 0x0f,
  structure_type: 0x13,
  union_type: 0x17,
  enumeration_type: 0x04,
  typedef: 0x16,
} as const;

export const DW_AT = {
  name: 0x03,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  stmt_list: 0x10,
  comp_dir: 0x1b,
  producer: 0x25,
  external: 0x3f,
  declaration: 0x3c,
  type: 0x49,
  location: 0x02,
} as const;

export const DW_FORM = {
  addr: 0x01,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
} as const;

export function parseDwarf(elfBuffer: Buffer): DWARFData {
  const view = new DataView(elfBuffer.buffer);

  // Check ELF magic
  if (
    elfBuffer[0] !== 0x7f ||
    elfBuffer[1] !== 0x45 ||
    elfBuffer[2] !== 0x4c ||
    elfBuffer[3] !== 0x46
  ) {
    throw new Error("Not a valid ELF file");
  }

  const is64bit = elfBuffer[4] === 2;
  const isLittleEndian = elfBuffer[5] === 1;

  // Helper functions
  function readUInt8(offset: number): number {
    const value = elfBuffer[offset];
    if (value === undefined) {
      throw new Error(`Invalid read at offset ${offset}`);
    }
    return value;
  }

  function readInt8(offset: number): number {
    const value = elfBuffer[offset];
    if (value === undefined) {
      throw new Error(`Invalid read at offset ${offset}`);
    }
    return value > 127 ? value - 256 : value;
  }

  function readUInt16(offset: number): number {
    return view.getUint16(offset, isLittleEndian);
  }

  function readUInt32(offset: number): number {
    return view.getUint32(offset, isLittleEndian);
  }

  function readUInt64(offset: number): number {
    const low = view.getUint32(offset, isLittleEndian);
    const high = view.getUint32(offset + 4, isLittleEndian);
    return isLittleEndian ? low + high * 0x100000000 : high + low * 0x100000000;
  }

  function readULEB128(offset: number): LEB128Result {
    let result = 0;
    let shift = 0;
    let size = 0;

    while (true) {
      const byte = elfBuffer[offset + size];
      if (byte === undefined) {
        throw new Error(`Invalid ULEB128 read at offset ${offset + size}`);
      }
      size++;

      result |= (byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) break;
      shift += 7;
    }

    return { value: result, size };
  }

  function readSLEB128(offset: number): LEB128Result {
    let result = 0;
    let shift = 0;
    let size = 0;
    let byte: number | undefined;

    do {
      byte = elfBuffer[offset + size];
      if (byte === undefined) {
        throw new Error(`Invalid SLEB128 read at offset ${offset + size}`);
      }
      size++;

      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    if (shift < 32 && byte & 0x40) {
      result |= -(1 << shift);
    }

    return { value: result, size };
  }

  function readString(offset: number): StringResult {
    let size = 0;
    let value = "";

    while (offset + size < elfBuffer.length) {
      const byte = elfBuffer[offset + size];
      if (byte === undefined || byte === 0) break;
      value += String.fromCharCode(byte);
      size++;
    }

    return { value, size: size + 1 };
  }

  // Parse ELF sections
  const headerSize = is64bit ? 64 : 52;
  const shoff = is64bit ? readUInt64(40) : readUInt32(32);
  const shentsize = readUInt16(headerSize - 6);
  const shnum = readUInt16(headerSize - 4);
  const shstrndx = readUInt16(headerSize - 2);

  function parseSectionHeader(offset: number): ELFSectionHeader {
    const nameOffset = readUInt32(offset);
    const type = readUInt32(offset + 4);
    const flags = is64bit ? readUInt64(offset + 8) : readUInt32(offset + 8);
    const addr = is64bit ? readUInt64(offset + 16) : readUInt32(offset + 12);
    const sectionOffset = is64bit
      ? readUInt64(offset + 24)
      : readUInt32(offset + 16);
    const size = is64bit ? readUInt64(offset + 32) : readUInt32(offset + 20);

    return {
      name: nameOffset.toString(),
      type,
      flags,
      addr,
      offset: sectionOffset,
      size,
    };
  }

  const sections = new Map<string, ELFSectionHeader>();

  // Parse section headers
  const strTabOffset = shoff + shstrndx * shentsize;
  const strTabHeader = parseSectionHeader(strTabOffset);
  const stringTable = new Uint8Array(
    elfBuffer.buffer,
    strTabHeader.offset,
    strTabHeader.size
  );

  for (let i = 0; i < shnum; i++) {
    const headerOffset = shoff + i * shentsize;
    const header = parseSectionHeader(headerOffset);

    const nameOffset = header.name as unknown as number;
    let name = "";
    for (let j = nameOffset; j < stringTable.length; j++) {
      const byte = stringTable[j];
      if (byte === undefined || byte === 0) break;
      name += String.fromCharCode(byte);
    }

    header.name = name;
    sections.set(name, header);
  }

  // Parse DWARF sections
  const compilationUnits: CompilationUnit[] = [];
  const lineNumberPrograms: LineNumberProgram[] = [];
  let debugStrings: Uint8Array | undefined;
  const abbreviationTables = new Map<number, AbbreviationEntry[]>();
  const elfSymbols: ELFSymbol[] = [];

  function parseAbbreviationEntry(offset: number): {
    entry: AbbreviationEntry;
    size: number;
  } {
    let currentOffset = offset;

    const code = readULEB128(currentOffset);
    currentOffset += code.size;

    if (code.value === 0) {
      return {
        entry: { code: 0, tag: 0, hasChildren: false, attributes: [] },
        size: code.size,
      };
    }

    const tag = readULEB128(currentOffset);
    currentOffset += tag.size;

    const hasChildren = readUInt8(currentOffset) === 1;
    currentOffset += 1;

    const attributes: Array<{ name: number; form: number }> = [];

    while (true) {
      const name = readULEB128(currentOffset);
      currentOffset += name.size;

      const form = readULEB128(currentOffset);
      currentOffset += form.size;

      if (name.value === 0 && form.value === 0) break;

      attributes.push({ name: name.value, form: form.value });
    }

    return {
      entry: {
        code: code.value,
        tag: tag.value,
        hasChildren,
        attributes,
      },
      size: currentOffset - offset,
    };
  }

  function parseAbbreviationTable(offset: number): AbbreviationEntry[] {
    const entries: AbbreviationEntry[] = [];
    let currentOffset = offset;

    while (true) {
      const result = parseAbbreviationEntry(currentOffset);
      if (result.entry.code === 0) break;

      entries.push(result.entry);
      currentOffset += result.size;
    }

    return entries;
  }

  function parseAttributeValue(
    offset: number,
    form: number,
    addressSize: number
  ): { value: any; size: number } {
    switch (form) {
      case DW_FORM.addr:
        return {
          value: addressSize === 8 ? readUInt64(offset) : readUInt32(offset),
          size: addressSize,
        };
      case DW_FORM.data1:
        return { value: readUInt8(offset), size: 1 };
      case DW_FORM.data2:
        return { value: readUInt16(offset), size: 2 };
      case DW_FORM.data4:
        return { value: readUInt32(offset), size: 4 };
      case DW_FORM.data8:
        return { value: readUInt64(offset), size: 8 };
      case DW_FORM.string: {
        const str = readString(offset);
        return { value: str.value, size: str.size };
      }
      case DW_FORM.strp:
        return { value: readUInt32(offset), size: 4 }; // Offset into .debug_str
      case DW_FORM.flag:
        return { value: readUInt8(offset) !== 0, size: 1 };
      case DW_FORM.udata: {
        const uleb = readULEB128(offset);
        return { value: uleb.value, size: uleb.size };
      }
      case DW_FORM.sdata: {
        const sleb = readSLEB128(offset);
        return { value: sleb.value, size: sleb.size };
      }
      case DW_FORM.ref4:
        return { value: readUInt32(offset), size: 4 };
      case DW_FORM.ref_udata: {
        const uleb = readULEB128(offset);
        return { value: uleb.value, size: uleb.size };
      }
      case DW_FORM.block1: {
        const length = readUInt8(offset);
        return {
          value: new Uint8Array(elfBuffer.buffer, offset + 1, length),
          size: 1 + length,
        };
      }
      case DW_FORM.block: {
        const length = readULEB128(offset);
        return {
          value: new Uint8Array(
            elfBuffer.buffer,
            offset + length.size,
            length.value
          ),
          size: length.size + length.value,
        };
      }
      default:
        // Unknown form, skip 4 bytes as fallback
        return { value: null, size: 4 };
    }
  }

  function parseDIE(
    offset: number,
    abbrevTable: AbbreviationEntry[],
    addressSize: number
  ): DebugInfoEntry | null {
    const abbrevCode = readULEB128(offset);
    if (abbrevCode.value === 0) return null;

    let currentOffset = offset + abbrevCode.size;

    // Find the abbreviation entry for this code
    const abbrevEntry = abbrevTable.find(
      (entry) => entry.code === abbrevCode.value
    );
    if (!abbrevEntry) {
      // Unknown abbreviation code, create minimal DIE
      return {
        abbrevCode: abbrevCode.value,
        tag: undefined,
        attributes: [],
        size: abbrevCode.size,
        children: [],
      };
    }

    const attributes: DWARFAttribute[] = [];

    // Parse attributes according to the abbreviation entry
    for (const attrSpec of abbrevEntry.attributes) {
      const attrValue = parseAttributeValue(
        currentOffset,
        attrSpec.form,
        addressSize
      );

      attributes.push({
        name: attrSpec.name,
        form: attrSpec.form,
        value: attrValue.value,
      });

      currentOffset += attrValue.size;
    }

    const die: DebugInfoEntry = {
      abbrevCode: abbrevCode.value,
      tag: abbrevEntry.tag,
      attributes,
      size: currentOffset - offset,
      children: [],
    };

    return die;
  }

  function parseCompilationUnit(offset: number): CompilationUnit {
    const startOffset = offset;
    const length = readUInt32(offset);
    offset += 4;

    const version = readUInt16(offset);
    offset += 2;

    const abbrevOffset = readUInt32(offset);
    offset += 4;

    const addressSize = elfBuffer[offset];
    if (addressSize === undefined) {
      throw new Error("Invalid address size in compilation unit");
    }
    offset += 1;

    const cu: CompilationUnit = {
      length,
      version,
      abbrevOffset,
      addressSize,
      offset: startOffset,
      dies: [],
    };

    // Get or parse abbreviation table for this compilation unit
    let abbrevTable = abbreviationTables.get(abbrevOffset);
    if (!abbrevTable) {
      // Parse abbreviation table if not already cached
      const abbrevSection = sections.get(".debug_abbrev");
      if (abbrevSection) {
        abbrevTable = parseAbbreviationTable(
          abbrevSection.offset + abbrevOffset
        );
        abbreviationTables.set(abbrevOffset, abbrevTable);
      } else {
        abbrevTable = [];
      }
    }

    const endOffset = startOffset + length + 4;
    while (offset < endOffset) {
      const die = parseDIE(offset, abbrevTable, addressSize);
      if (!die) break;
      cu.dies.push(die);
      offset += die.size;
    }

    return cu;
  }

  function parseLineNumberInstruction(
    offset: number,
    program: LineNumberProgram
  ): LineNumberInstruction {
    const opcode = elfBuffer[offset];
    if (opcode === undefined) {
      throw new Error("Invalid opcode in line number instruction");
    }

    let size = 1;
    const instruction: LineNumberInstruction = { opcode, size };

    if (opcode === 0) {
      const length = readULEB128(offset + 1);
      size += length.size;
      const extOpcode = elfBuffer[offset + size];
      if (extOpcode === undefined) {
        throw new Error("Invalid extended opcode");
      }
      size += 1;

      instruction.extended = true;
      instruction.length = length.value;
      instruction.extOpcode = extOpcode;
      instruction.type = "extended";

      switch (extOpcode) {
        case 1:
          instruction.name = "end_sequence";
          break;
        case 2: {
          const address = is64bit
            ? readUInt64(offset + size)
            : readUInt32(offset + size);
          instruction.name = "set_address";
          instruction.address = address;
          size += is64bit ? 8 : 4;
          break;
        }
        case 3: {
          const fileName = readString(offset + size);
          size += fileName.size;
          instruction.name = "define_file";
          instruction.fileName = fileName.value;
          break;
        }
      }
    } else if (opcode < program.opcodeBase) {
      instruction.type = "standard";

      switch (opcode) {
        case 1:
          instruction.name = "copy";
          break;
        case 2: {
          const advance = readULEB128(offset + 1);
          instruction.name = "advance_pc";
          instruction.advance = advance.value;
          size += advance.size;
          break;
        }
        case 3: {
          const lineAdvance = readSLEB128(offset + 1);
          instruction.name = "advance_line";
          instruction.advance = lineAdvance.value;
          size += lineAdvance.size;
          break;
        }
        case 4: {
          const file = readULEB128(offset + 1);
          instruction.name = "set_file";
          instruction.file = file.value;
          size += file.size;
          break;
        }
        case 5: {
          const column = readULEB128(offset + 1);
          instruction.name = "set_column";
          instruction.column = column.value;
          size += column.size;
          break;
        }
        case 6:
          instruction.name = "negate_stmt";
          break;
        case 7:
          instruction.name = "set_basic_block";
          break;
        case 8:
          instruction.name = "const_add_pc";
          break;
        case 9: {
          const fixedAdvance = readUInt16(offset + 1);
          instruction.name = "fixed_advance_pc";
          instruction.advance = fixedAdvance;
          size += 2;
          break;
        }
      }
    } else {
      instruction.type = "special";
      const adjustedOpcode = opcode - program.opcodeBase;
      const addressAdvance = Math.floor(adjustedOpcode / program.lineRange);
      const lineAdvance =
        program.lineBase + (adjustedOpcode % program.lineRange);

      instruction.addressAdvance = addressAdvance;
      instruction.lineAdvance = lineAdvance;
    }

    instruction.size = size;
    return instruction;
  }

  function parseLineNumberProgram(offset: number): LineNumberProgram {
    const startOffset = offset;
    const unitLength = readUInt32(offset);
    offset += 4;

    const version = readUInt16(offset);
    offset += 2;

    const headerLength = readUInt32(offset);
    offset += 4;

    const minimumInstructionLength = elfBuffer[offset++];
    const defaultIsStmt = elfBuffer[offset++] === 1;
    const lineBase = readInt8(offset++);
    const lineRange = elfBuffer[offset++];
    const opcodeBase = elfBuffer[offset++];

    if (
      minimumInstructionLength === undefined ||
      lineRange === undefined ||
      opcodeBase === undefined
    ) {
      throw new Error("Invalid line number program header");
    }

    const standardOpcodeLengths: number[] = [];
    for (let i = 1; i < opcodeBase; i++) {
      const length = elfBuffer[offset++];
      if (length === undefined) {
        throw new Error("Invalid standard opcode length");
      }
      standardOpcodeLengths.push(length);
    }

    const includeDirectories: string[] = [];
    while (elfBuffer[offset] !== 0) {
      const dir = readString(offset);
      includeDirectories.push(dir.value);
      offset += dir.size;
    }
    offset++;

    const fileNames: FileEntry[] = [];
    while (elfBuffer[offset] !== 0) {
      const fileName = readString(offset);
      offset += fileName.size;

      const dirIndex = readULEB128(offset);
      offset += dirIndex.size;

      const modTime = readULEB128(offset);
      offset += modTime.size;

      const fileSize = readULEB128(offset);
      offset += fileSize.size;

      fileNames.push({
        name: fileName.value,
        directoryIndex: dirIndex.value,
        modificationTime: modTime.value,
        size: fileSize.value,
      });
    }
    offset++;

    const program: LineNumberProgram = {
      totalLength: unitLength,
      version,
      headerLength,
      minimumInstructionLength,
      defaultIsStmt,
      lineBase,
      lineRange,
      opcodeBase,
      standardOpcodeLengths,
      includeDirectories,
      fileNames,
      instructions: [],
    };

    const programEnd = startOffset + unitLength + 4;
    while (offset < programEnd) {
      const instruction = parseLineNumberInstruction(offset, program);
      program.instructions.push(instruction);
      offset += instruction.size;
    }

    return program;
  }

  function parseELFSymbols(): void {
    // Find .symtab and .strtab sections
    const symtabSection = sections.get(".symtab");
    const strtabSection = sections.get(".strtab");

    if (!symtabSection || !strtabSection) {
      return; // No symbol table found
    }

    const strtabData = new Uint8Array(
      elfBuffer.buffer,
      strtabSection.offset,
      strtabSection.size
    );

    // Symbol table entry size (16 bytes for 32-bit, 24 bytes for 64-bit)
    const symEntrySize = is64bit ? 24 : 16;
    const numSymbols = symtabSection.size / symEntrySize;

    for (let i = 0; i < numSymbols; i++) {
      const offset = i * symEntrySize;

      // Parse symbol table entry
      let nameOffset: number;
      let value: number;
      let size: number;
      let info: number;
      let other: number;
      let sectionIndex: number;

      if (is64bit) {
        // 64-bit symbol table entry layout
        nameOffset = readUInt32(symtabSection.offset + offset);
        info = readUInt8(symtabSection.offset + offset + 4);
        other = readUInt8(symtabSection.offset + offset + 5);
        sectionIndex = readUInt16(symtabSection.offset + offset + 6);
        value = readUInt64(symtabSection.offset + offset + 8);
        size = readUInt64(symtabSection.offset + offset + 16);
      } else {
        // 32-bit symbol table entry layout
        nameOffset = readUInt32(symtabSection.offset + offset);
        value = readUInt32(symtabSection.offset + offset + 4);
        size = readUInt32(symtabSection.offset + offset + 8);
        info = readUInt8(symtabSection.offset + offset + 12);
        other = readUInt8(symtabSection.offset + offset + 13);
        sectionIndex = readUInt16(symtabSection.offset + offset + 14);
      }

      // Extract symbol name from string table
      let name = "";
      if (nameOffset > 0 && nameOffset < strtabData.length) {
        let j = nameOffset;
        while (j < strtabData.length && strtabData[j] !== 0) {
          name += String.fromCharCode(strtabData[j]);
          j++;
        }
      }

      // Extract type and bind from info byte
      const type = info & 0xf;
      const bind = info >> 4;
      const visibility = other & 0x3;

      // Only include meaningful symbols (skip null symbol at index 0)
      if (i > 0 && name.length > 0) {
        elfSymbols.push({
          name,
          value,
          size,
          type,
          bind,
          visibility,
          sectionIndex,
        });
      }
    }
  }

  // Parse .debug_info section
  if (sections.has(".debug_info")) {
    const section = sections.get(".debug_info");
    if (section) {
      let offset = section.offset;
      const endOffset = section.offset + section.size;

      while (offset < endOffset) {
        const cu = parseCompilationUnit(offset);
        compilationUnits.push(cu);
        offset += cu.length + (is64bit ? 12 : 4);
      }
    }
  }

  // Parse .debug_line section
  if (sections.has(".debug_line")) {
    const section = sections.get(".debug_line");
    if (section) {
      let offset = section.offset;
      const endOffset = section.offset + section.size;

      while (offset < endOffset) {
        const program = parseLineNumberProgram(offset);
        lineNumberPrograms.push(program);
        offset += program.totalLength + (is64bit ? 12 : 4);
      }
    }
  }

  // Parse .debug_str section
  if (sections.has(".debug_str")) {
    const section = sections.get(".debug_str");
    if (section) {
      debugStrings = new Uint8Array(
        elfBuffer.buffer,
        section.offset,
        section.size
      );
    }
  }

  // Parse ELF symbol table
  parseELFSymbols();

  return {
    sections,
    compilationUnits,
    lineNumberPrograms,
    debugStrings,
    abbreviationTables,
    elfSymbols,
    is64bit,
    isLittleEndian,
  };
}
