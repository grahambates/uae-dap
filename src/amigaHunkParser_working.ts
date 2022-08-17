import { readFile } from "fs/promises";

export interface Hunk {
  index: number;
  fileOffset: number;
  hunkType: HunkType;
  /** Type of memory to allocate */
  memType: MemoryType;
  /** Number of bytes to allocate */
  allocSize: number;
  reloc32: RelocInfo32[];
  symbols: SourceSymbol[];
  lineDebugInfo: DebugInfo[];
  dataSize: number;
  dataOffset?: number;
  data?: Buffer;
}

export enum HunkType {
  CODE = "CODE",
  DATA = "DATA",
  BSS = "BSS",
}

export enum MemoryType {
  ANY = "ANY",
  CHIP = "CHIP",
  FAST = "FAST",
}

export interface RelocInfo32 {
  target: number;
  offsets: Array<number>;
}

export interface SourceSymbol {
  name: string;
  offset: number;
}

export interface SourceLine {
  line: number;
  offset: number;
}

export interface DebugInfo {
  sourceFilename: string;
  baseOffset: number;
  lines: SourceLine[];
}

const BlockTypes = {
  HEADER: 1011, // 0x3f3
  UNIT: 999,
  NAME: 1000,
  CODE: 1001,
  DATA: 1002,
  BSS: 1003,
  RELOC32: 1004,
  DEBUG: 1009,
  SYMBOL: 1008,
  END: 1010,
};

const DEBUG_LINE = 0x4c494e45;

/**
 * Extract an array of Hunks from an Amiga executable file
 */
export async function parseHunksFromFile(filename: string): Promise<Hunk[]> {
  const buffer = await readFile(filename);
  return parseHunks(buffer);
}

/**
 * Extract an array of Hunks from Amiga executable file data
 */
export function parseHunks(contents: Buffer): Hunk[] {
  const reader = new BufferReader(contents);

  // Read header data:
  const hunkHeader = reader.readLong();
  reader.skip(4); // Skip header/string section
  const tableSize = reader.readLong();
  const firstHunk = reader.readLong();
  const lastHunk = reader.readLong();

  // Validate
  if (hunkHeader !== BlockTypes.HEADER) {
    throw new Error(
      "Not a valid hunk file : Unable to find correct HUNK_HEADER"
    );
  }
  if (tableSize < 0 || firstHunk < 0 || lastHunk < 0) {
    throw new Error("Not a valid hunk file : Invalid sizes for hunks");
  }

  // Build hunk table:
  // This contains the size and memory type for each hunk
  const hunkCount = lastHunk - firstHunk + 1;
  const hunkTable: { memType: MemoryType; size: number }[] = [];
  for (let i = 0; i < hunkCount; i++) {
    const t = reader.readLong();
    hunkTable.push({ memType: getMemoryType(t), size: getSize(t) });
  }

  // Build hunks array:
  const hunks: Hunk[] = [];
  for (let i = 0; i < hunkCount; i++) {
    const hunk: Hunk = {
      index: i,
      fileOffset: reader.offset(),
      memType: hunkTable[i].memType,
      hunkType: HunkType.CODE, // Placeholder
      allocSize: hunkTable[i].size,
      dataSize: 0, // Placeholder
      symbols: [],
      reloc32: [],
      lineDebugInfo: [],
    };
    // Read hunk data to populate object
    fillHunk(hunk, reader);
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * Manages reading BE data from buffer and tracking offset position
 */
class BufferReader {
  private pos = 0;
  constructor(private buffer: Buffer) {}

  public readLong() {
    const value = this.buffer.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  public readByte() {
    return this.buffer.readUInt8(this.pos++);
  }

  public readBytes(length: number): Buffer {
    const slice = this.buffer.slice(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  public readString(length: number) {
    const startPos = this.pos;
    const charCodes: number[] = [];
    for (let i = 0; i < length; i++) {
      const v = this.readByte();
      if (v === 0) break;
      charCodes.push(v);
    }
    this.pos = startPos + length;
    return String.fromCharCode(...charCodes);
  }

  public skip(bytes: number) {
    this.pos += bytes;
  }

  public finished(): boolean {
    return this.pos > this.buffer.length - 2;
  }

  public offset(): number {
    return this.pos;
  }
}

function fillHunk(hunk: Hunk, reader: BufferReader) {
  let blockType = reader.readLong();
  while (blockType !== BlockTypes.END) {
    switch (blockType) {
      case BlockTypes.CODE:
        // uint32 	N 	The number of longwords of code.
        // uint32 * N 		Machine code.
        hunk.hunkType = HunkType.CODE;
        hunk.dataSize = getSize(reader.readLong());
        hunk.dataOffset = reader.offset();
        hunk.data = reader.readBytes(hunk.dataSize);
        break;
      case BlockTypes.DATA:
        // uint32 	N 	The number of longwords of data.
        // uint32 * N 		Data.
        hunk.hunkType = HunkType.DATA;
        hunk.dataSize = getSize(reader.readLong());
        hunk.dataOffset = reader.offset();
        hunk.data = reader.readBytes(hunk.dataSize);
        break;
      case BlockTypes.BSS:
        // uint32 		The number of longwords of zeroed memory to allocate.
        hunk.hunkType = HunkType.BSS;
        hunk.dataSize = getSize(reader.readLong());
        break;
      case BlockTypes.DEBUG:
        hunk.lineDebugInfo = parseDebug(reader);
        break;
      case BlockTypes.RELOC32:
        hunk.reloc32 = parseReloc32(reader);
        break;
      case BlockTypes.SYMBOL:
        hunk.symbols = parseSymbols(reader);
        break;
      default:
        reader.skip(getSize(reader.readLong()) + 4);
        break;
    }
    if (reader.finished()) {
      break;
    }
    blockType = reader.readLong();
  }
}

function getSize(t: number): number {
  return (t & 0x0fffffff) * 4;
}

function getMemoryType(t: number): MemoryType {
  const memT = t & 0xf0000000;
  if (memT === 1 << 30) {
    return MemoryType.CHIP;
  } else if (memT === 1 << 31) {
    return MemoryType.FAST;
  } else {
    return MemoryType.ANY;
  }
}

function parseSymbols(reader: BufferReader): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  /*
  uint32 N      The number of longwords following in the given hunk. If this value is zero,
                then it indicates the immediate end of this block.
  */
  let numLongs = reader.readLong();
  while (numLongs > 0) {
    /*
    string 		The name of the current symbol.
              A zero size indicates the immediate end of this block.
    uint32 		The offset of the current symbol from the start of the hunk.
    */
    symbols.push({
      name: reader.readString(numLongs * 4),
      offset: reader.readLong(),
    });
    numLongs = reader.readLong();
  }
  // Sort symbols by offset ?
  if (symbols.length > 0) {
    symbols.sort(function (a, b) {
      return a.offset > b.offset ? 1 : b.offset > a.offset ? -1 : 0;
    });
  }
  return symbols;
}

function parseDebug(reader: BufferReader): DebugInfo[] {
  /*
  uint32 N      The number of longwords following in the given hunk. If this value is zero,
                then it indicates the immediate end of this block.
  uint32 		    The base offset within the source file.
  char[4] 		  "LINE"
  string 		    The source file name.
  line_info[M]  The table of line offsets within the local code, data or bss section.
  */
  const debugInfo: DebugInfo[] = [];
  const numLongs = reader.readLong() - 2; // skip base offset and tag
  const baseOffset = reader.readLong();
  const debugTag = reader.readString(4);

  // We only support debug line as debug format currently so skip if not found
  if (debugTag === "LINE") {
    const numNameLongs = reader.readLong();
    const sourceFilename = reader.readString(numNameLongs * 4);
    const numLines = (numLongs - numNameLongs - 1) / 2;
    const lines: SourceLine[] = [];

    for (let i = 0; i < numLines; i++) {
      /*
      uint32 		Line number.
      uint32 		Offset of line from base offset.
      */
      lines.push({
        line: reader.readLong() & 0xffffff, // mask for SAS/C extra info
        offset: baseOffset + reader.readLong(),
      });
    }
    debugInfo.push({ sourceFilename, baseOffset, lines });
  } else {
    reader.skip(numLongs * 4);
  }
  return debugInfo;
}

function parseReloc32(reader: BufferReader): RelocInfo32[] {
  const reloc32 = [];
  // uint32 	N 	The number of offsets for a given hunk.
  //              If this value is zero, then it indicates the immediate end of this block.
  // uint32 		  The number of the hunk the offsets are to point into.
  // uint32 * N   Offsets in the current CODE or DATA hunk to relocate.
  let count = reader.readLong();
  while (count > 0) {
    const reloc: RelocInfo32 = {
      target: reader.readLong(),
      offsets: [],
    };
    for (let i = 0; i < count; i++) {
      reloc.offsets.push(reader.readLong());
    }
    reloc32.push(reloc);
    count = reader.readLong();
  }
  return reloc32;
}
