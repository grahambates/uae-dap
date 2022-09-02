/**
 * Parses Hunk data in Amiga executable file
 *
 * @see {@link http://amiga-dev.wikidot.com/file-format:hunk}
 */

import { readFile } from "fs/promises";

export interface Hunk {
  index: number;
  /** Byte offset of this hunk in executable file */
  fileOffset: number;
  hunkType: HunkType;
  /** Type of memory to allocate */
  memType: MemoryType;
  /** Number of bytes to allocate */
  allocSize: number;
  /** Relocation information */
  reloc32: RelocInfo32[];
  /** Symbols defined in this hunk (if exported) */
  symbols: SourceSymbol[];
  /** Offsets of source files / lines (if exported in Line Debug data) */
  lineDebugInfo: DebugInfo[];
  /** Size of code/data binary in this hunk or to allocate in case of BSS */
  dataSize?: number;
  /** Byte offset of code/data binary relative to this hunk */
  dataOffset?: number;
  /** code/data binary */
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
  offsets: number[];
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

type Allocation = { memType: MemoryType; allocSize: number };

const BlockTypes = {
  CODE: 0x3e9,
  DATA: 0x3ea,
  BSS: 0x3eb,
  RELOC32: 0x3ec,
  SYMBOL: 0x3f0,
  DEBUG: 0x3f1,
  END: 0x3f2,
  HEADER: 0x3f3,
};

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

  // Check 'magic cookie' to ensure header type
  const type = reader.readLong();
  if (type !== BlockTypes.HEADER) {
    throw new Error(
      "Not a valid hunk file : Unable to find correct HUNK_HEADER"
    );
  }

  return parseHeader(reader).map((hunkInfo, index) =>
    createHunk(hunkInfo, index, reader)
  );
}

/**
 * Parse header block to build hunk table, containing the size and memory type for each hunk
 */
function parseHeader(reader: BufferReader): Allocation[] {
  // HUNK_HEADER:
  // strings   A number of resident library names.
  // uint32    Table size. The highest hunk number plus one.
  // uint32 F  First hunk. The first hunk that should be used in loading.
  // uint32 L  Last hunk. The last hunk that should be used in loading.
  // uint32 * (L-F+1)     A list of hunk sizes.
  reader.skip(4); // Skip header/string section
  const tableSize = reader.readLong();
  const firstHunk = reader.readLong();
  const lastHunk = reader.readLong();

  // Validate sizes
  if (tableSize < 0 || firstHunk < 0 || lastHunk < 0) {
    throw new Error("Not a valid hunk file : Invalid sizes for hunks");
  }

  const hunkTable: Allocation[] = [];
  const hunkCount = lastHunk - firstHunk + 1;
  for (let i = 0; i < hunkCount; i++) {
    //  The hunk size of each block is expected to indicate in its two highest bits which flags to pass to AllocMem.
    // Bit 31   Bit 30  Description
    // 0        0       The hunk can be loaded into whatever memory is available, with a preference for fast memory.
    // 1        0       The hunk should be loaded into fast memory or the process should fail.
    // 0        1       The hunk should be loaded into chip memory or the process should fail.
    //                  TODO: not supported
    // 1        1       Indicates an additional following longword containing the specific flags, of which bit 30 gets cleared before use.
    const hunkSize = reader.readLong();
    let memType = MemoryType.ANY;
    const masked = hunkSize & 0xf0000000; // Mask lower bytes containing size
    if (masked === 1 << 30) {
      memType = MemoryType.CHIP;
    } else if (masked === 1 << 31) {
      memType = MemoryType.FAST;
    }
    hunkTable.push({
      memType,
      allocSize: (hunkSize & 0x0fffffff) * 4, // Mask upper bytes containing memory type
    });
  }
  return hunkTable;
}

function createHunk(
  { memType, allocSize }: Allocation,
  index: number,
  reader: BufferReader
): Hunk {
  // Create a minimal object with the info we have:
  const hunk: Hunk = {
    index,
    fileOffset: reader.offset(),
    memType,
    hunkType: HunkType.CODE, // Placeholder for valid type
    allocSize,
    symbols: [],
    reloc32: [],
    lineDebugInfo: [],
  };

  // Populate with block data from the reader:
  let blockType = reader.readLong();
  while (blockType !== BlockTypes.END) {
    switch (blockType) {
      // Initial hunk blocks:
      // These define the type and content of the hunk
      case BlockTypes.CODE:
        // uint32   N   The number of longwords of code.
        // uint32 * N   Machine code.
        hunk.hunkType = HunkType.CODE;
        hunk.dataSize = reader.readLong() * 4;
        hunk.dataOffset = reader.offset();
        hunk.data = reader.readBytes(hunk.dataSize);
        break;
      case BlockTypes.DATA:
        // uint32   N   The number of longwords of data.
        // uint32 * N   Data.
        hunk.hunkType = HunkType.DATA;
        hunk.dataSize = reader.readLong() * 4;
        hunk.dataOffset = reader.offset();
        hunk.data = reader.readBytes(hunk.dataSize);
        break;
      case BlockTypes.BSS:
        // uint32     The number of longwords of zeroed memory to allocate.
        hunk.hunkType = HunkType.BSS;
        hunk.allocSize = reader.readLong() * 4; // Is this always the same as in hunk table?
        break;

      // Additional hunk blocks:
      // These provide additional properties
      case BlockTypes.DEBUG: {
        const info = parseDebug(reader);
        if (info) {
          hunk.lineDebugInfo.push(info);
        }
        break;
      }
      case BlockTypes.RELOC32:
        hunk.reloc32.push(...parseReloc32(reader));
        break;
      case BlockTypes.SYMBOL:
        hunk.symbols.push(...parseSymbols(reader));
        break;

      // Skip all other block types
      default:
        reader.skip(reader.readLong() * 4);
        break;
    }
    if (reader.finished()) {
      break;
    }
    blockType = reader.readLong();
  }
  return hunk;
}

function parseSymbols(reader: BufferReader): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  // HUNK_SYMBOL [0x3F0]
  // string     The name of the current symbol. A zero size indicates the immediate end of this block.
  // uint32     The offset of the current symbol from the start of the hunk.
  let numLongs = reader.readLong();
  while (numLongs > 0) {
    // String:
    // uint32   N   The number of uint32s that compose the string.
    // uint32 * N   Each uint32 is composed of four characters, with the exception of the last uint32.
    //              Extra space at the end of the last uint32 is filled with the 0 byte.
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

function parseDebug(reader: BufferReader): DebugInfo | null {
  // "LINE" - Generic debug hunk format
  // uint32 N      The number of longwords following in the given hunk. If this value is zero,
  //               then it indicates the immediate end of this block.
  // uint32        The base offset within the source file.
  // char[4]        "LINE"
  // string        The source file name.
  // line_info[M]  The table of line offsets within the local code, data or bss section.
  const numLongs = reader.readLong();
  const baseOffset = reader.readLong();
  const debugTag = reader.readString(4);

  // We only support debug line as debug format currently so skip others
  if (debugTag !== "LINE") {
    reader.skip((numLongs - 2) * 4);
    return null;
  }

  // String:
  // uint32   N   The number of uint32s that compose the string.
  // uint32 * N   Each uint32 is composed of four characters, with the exception of the last uint32.
  //              Extra space at the end of the last uint32 is filled with the 0 byte.
  const numNameLongs = reader.readLong();
  const sourceFilename = reader.readString(numNameLongs * 4);

  const numLines = (numLongs - numNameLongs - 3) / 2; // 3 longs + name already read, 2 per item
  const lines: SourceLine[] = [];

  for (let i = 0; i < numLines; i++) {
    // line_info:
    // uint32     Line number.
    // uint32     Offset of line from base offset.
    lines.push({
      line: reader.readLong() & 0xffffff, // mask for SAS/C extra info
      offset: baseOffset + reader.readLong(),
    });
  }
  return { sourceFilename, lines, baseOffset };
}

function parseReloc32(reader: BufferReader): RelocInfo32[] {
  // HUNK_RELOC32 [0x3EC]:
  // uint32   N   The number of offsets for a given hunk.
  //              If this value is zero, then it indicates the immediate end of this block.
  // uint32       The number of the hunk the offsets are to point into.
  // uint32 * N   Offsets in the current CODE or DATA hunk to relocate.
  const relocs: RelocInfo32[] = [];
  let count = reader.readLong();
  while (count !== 0) {
    const target = reader.readLong();
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) {
      offsets.push(reader.readLong());
    }
    relocs.push({ target, offsets });
    count = reader.readLong();
  }
  return relocs;
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
