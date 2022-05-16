import { URI as Uri } from "vscode-uri";
import { readFile } from "fs/promises";
import { Logger } from "@vscode/debugadapter";

const DEBUG_LINE = 0x4c494e45;

export enum HunkType {
  HEADER = 1011, // 0x3f3
  UNIT = 999,
  NAME = 1000,
  CODE = 1001,
  DATA = 1002,
  BSS = 1003,
  RELOC32 = 1004,
  DEBUG = 1009,
  SYMBOL = 1008,
  END = 1010,
}

export interface RelocInfo32 {
  target: number;
  offsets: Array<number>;
}

export interface Symbol {
  name: string;
  offset: number;
}

export interface SourceLine {
  line: number;
  offset: number;
}

export interface SourceFile {
  name: string;
  baseOffset: number;
  lines: Array<SourceLine>;
}

export interface Hunk {
  index: number;
  fileOffset: number;
  memType: MemoryType;
  hunkType?: HunkType;
  allocSize: number;
  dataSize?: number;
  dataOffset?: number;
  codeData?: Uint32Array;
  reloc32?: Array<RelocInfo32>;
  // eslint-disable-next-line @typescript-eslint/ban-types
  symbols?: Array<Symbol>;
  lineDebugInfo?: Array<SourceFile>;
  segmentsId?: number;
  segmentsAddress?: number;
}

export enum MemoryType {
  ANY,
  CHIP = 1 << 30,
  FAST = 1 << 31,
}

export interface SizesTypes {
  memType: MemoryType;
  size: number;
}

export class HunkParser {
  constructor(private logger: Logger.ILogger = Logger.logger) {}

  private skipHunk(fileData: DataView, fileOffset: number): number {
    const [size] = this.getSizeType(fileData.getUint32(fileOffset, false));
    return fileOffset + size + 4;
  }

  public getSizeType(t: number): [number, MemoryType] {
    const size = (t & 0x0fffffff) * 4;
    const memT = t & 0xf0000000;
    let memType: MemoryType;
    switch (memT) {
      case MemoryType.CHIP:
        memType = MemoryType.CHIP;
        break;
      case MemoryType.FAST:
        memType = MemoryType.FAST;
        break;
      default:
        memType = MemoryType.ANY;
        break;
    }
    return [size, memType];
  }

  private toArrayBuffer(buf: Buffer): ArrayBuffer {
    const ab = new ArrayBuffer(buf.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buf.length; ++i) {
      view[i] = buf[i];
    }
    return ab;
  }

  public parseBss(hunk: Hunk, fileData: DataView, fileOffset: number): number {
    const size = fileData.getUint32(fileOffset, false);
    // BSS contains the The number of long words of zeroed memory to allocate
    hunk.hunkType = HunkType.BSS;
    hunk.dataSize = size;
    return fileOffset + 4;
  }

  public parseCodeOrData(
    hunkType: HunkType,
    hunk: Hunk,
    fileData: DataView,
    fileOffset: number
  ): number {
    const [size] = this.getSizeType(fileData.getUint32(fileOffset, false));
    const codeData = new Uint32Array(size / 4);
    let pos = fileOffset + 4;

    hunk.dataSize = size;
    hunk.dataOffset = pos;
    hunk.hunkType = hunkType;

    for (let i = 0; i < size / 4; i += 1) {
      codeData[i] = fileData.getInt32(pos, false);
      pos += 4;
    }

    hunk.codeData = codeData;
    return pos;
  }

  protected findStringEnd(fileData: DataView, fileOffset: number): number {
    let pos = fileOffset;
    let v = fileData.getUint32(pos, false);
    while (v !== 0) {
      pos += 1;
      v = fileData.getUint32(pos, false);
    }
    return pos - fileOffset;
  }
  protected readNameSize(
    fileData: DataView,
    fileOffset: number,
    numUi32: number
  ): string {
    const lenBytes = numUi32 * 4;
    const tempBuffer = new Array<number>(512);
    let pos = fileOffset;
    let idx = 0;
    let v = fileData.getUint8(pos);
    pos += 1;
    while (v !== 0 && pos < fileOffset + lenBytes + 1) {
      tempBuffer[idx++] = v;
      v = fileData.getUint8(pos++);
    }
    return String.fromCharCode(...tempBuffer.slice(0, idx));
  }

  protected parseSymbols(
    hunk: Hunk,
    fileData: DataView,
    fileOffset: number
  ): number {
    // eslint-disable-next-line @typescript-eslint/ban-types
    const symbols = new Array<Symbol>();
    let pos = fileOffset;
    let numLongs = fileData.getUint32(pos, false);
    pos += 4;
    while (numLongs > 0) {
      // eslint-disable-next-line @typescript-eslint/ban-types
      const symbol: Symbol = {
        name: this.readNameSize(fileData, pos, numLongs),
        offset: fileData.getUint32(pos + numLongs * 4, false),
      };
      symbols.push(symbol);
      pos += numLongs * 4 + 4;
      numLongs = fileData.getUint32(pos, false);
      pos += 4;
    }
    // Sort symbols by offset ?
    if (symbols.length > 0) {
      symbols.sort(function (a, b) {
        return a.offset > b.offset ? 1 : b.offset > a.offset ? -1 : 0;
      });
      hunk.symbols = symbols;
    }
    return pos;
  }
  protected fillDebugInfo(
    baseOffset: number,
    numLongs: number,
    fileData: DataView,
    fileOffset: number
  ): SourceFile {
    let pos = fileOffset;
    const numNameLongs = fileData.getUint32(pos, false);
    pos += 4;
    const name = this.readNameSize(fileData, pos, numNameLongs);
    pos += numNameLongs * 4;
    const numLines = (numLongs - numNameLongs - 1) / 2;
    const lines = new Array<SourceLine>();

    for (let i = 0; i < numLines; i++) {
      const lineNo = fileData.getUint32(pos, false) & 0xffffff; // mask for SAS/C extra info
      pos += 4;
      const offset = fileData.getUint32(pos, false);
      pos += 4;
      lines.push({
        line: lineNo,
        offset: baseOffset + offset,
      });
    }

    return {
      name: name,
      baseOffset: baseOffset,
      lines: lines,
    };
  }

  protected parseDebug(
    hunk: Hunk,
    fileData: DataView,
    fileOffset: number
  ): number {
    let pos = fileOffset;
    const numLongs = fileData.getUint32(pos, false) - 2; // skip base offset and tag
    pos += 4;
    const baseOffset = fileData.getUint32(pos, false);
    pos += 4;
    const debugTag = fileData.getUint32(pos, false);
    pos += 4;

    // We only support debug line as debug format currently so skip if not found
    if (debugTag === DEBUG_LINE) {
      let debugInfo = hunk.lineDebugInfo;
      if (!debugInfo) {
        debugInfo = new Array<SourceFile>();
        hunk.lineDebugInfo = debugInfo;
      }
      const sourceFile = this.fillDebugInfo(
        baseOffset,
        numLongs,
        fileData,
        pos
      );
      debugInfo.push(sourceFile);
    }
    return pos + numLongs * 4;
  }

  protected parseReloc32(
    hunk: Hunk,
    fileData: DataView,
    fileOffset: number
  ): number {
    const relocs = new Array<RelocInfo32>();
    let pos = fileOffset;
    let count = fileData.getUint32(pos, false);
    pos += 4;
    while (count > 0) {
      const target = fileData.getUint32(pos, false);
      pos += 4;
      const reloc: RelocInfo32 = {
        target,
        offsets: [],
      };
      for (let i = 0; i < count; i++) {
        reloc.offsets.push(fileData.getUint32(pos, false));
        pos += 4;
      }
      relocs.push(reloc);
      count = fileData.getUint32(pos, false);
      pos += 4;
    }
    hunk.reloc32 = relocs;
    return pos;
  }

  public fillHunk(hunk: Hunk, fileData: DataView, fileOffset: number): number {
    let pos = fileOffset;
    let hunkType = fileData.getUint32(pos, false);
    pos += 4;
    while (hunkType !== HunkType.END) {
      switch (hunkType) {
        case HunkType.DEBUG:
          this.logger.log(`Block DEBUG offset $${pos.toString(16)}`);
          pos = this.parseDebug(hunk, fileData, pos);
          break;
        case HunkType.CODE:
          this.logger.log(`Block CODE offset $${pos.toString(16)}`);
          pos = this.parseCodeOrData(HunkType.CODE, hunk, fileData, pos);
          break;
        case HunkType.DATA:
          this.logger.log(`Block DATA offset $${pos.toString(16)}`);
          pos = this.parseCodeOrData(HunkType.DATA, hunk, fileData, pos);
          break;
        case HunkType.BSS:
          this.logger.log(`Block BSS offset $${pos.toString(16)}`);
          pos = this.parseBss(hunk, fileData, pos);
          break;
        case HunkType.RELOC32:
          this.logger.log(`Block RELOC32 offset $${pos.toString(16)}`);
          pos = this.parseReloc32(hunk, fileData, pos);
          break;
        case HunkType.SYMBOL:
          this.logger.log(`Block SYMBOL offset $${pos.toString(16)}`);
          pos = this.parseSymbols(hunk, fileData, pos);
          break;
        case HunkType.UNIT:
          this.logger.log(`Block UNIT offset $${pos.toString(16)}`);
          pos = this.skipHunk(fileData, pos);
          break;
        case HunkType.NAME:
          this.logger.log(`Block NAME offset $${pos.toString(16)}`);
          break;
        case HunkType.END:
          this.logger.log(`Block END offset $${pos.toString(16)}`);
          break;
        default:
          // thrown error : unknown "Unknown hunk type {:x}", hunkType
          break;
      }
      if (pos > fileData.byteLength - 2) {
        break;
      } else {
        hunkType = fileData.getUint32(pos, false);
        pos += 4;
      }
    }
    return pos;
  }

  public logHunk(hunk: Hunk): void {
    this.logger.log(
      `Hunk #${hunk.index} offset $${hunk.fileOffset.toString(16)}`
    );
    // this.logger.log(`    > hunkType   : ${HunkType[hunk.hunkType]}`);
    this.logger.log(`    > memType    : ${MemoryType[hunk.memType]}`);
    this.logger.log(`    > dataSize   : ${hunk.dataSize}`);
    if (hunk.dataOffset) {
      this.logger.log(`    > dataOffset : $${hunk.dataOffset.toString(16)}`);
    }
    this.logger.log(`    > allocSize  : ${hunk.allocSize}`);
    if (hunk.reloc32) {
      for (const reloc of hunk.reloc32) {
        const offsets = Array<string>();
        for (const relocOffset of reloc.offsets) {
          offsets.push(`$${relocOffset.toString(16)}`);
        }
        const s = offsets.join(",");
        this.logger.log(`    > reloc[${reloc.target}] : ${s}`);
      }
    }
    if (hunk.symbols) {
      for (const symbol of hunk.symbols) {
        this.logger.log(
          `    > symbol[${symbol.name}] : $${symbol.offset.toString(16)}`
        );
      }
    }
    if (hunk.lineDebugInfo) {
      for (const sourceFile of hunk.lineDebugInfo) {
        this.logger.log(`    > lineDebugInfo : ${sourceFile.name}`);
      }
    }
  }

  public parseFile(contents: Buffer): Array<Hunk> {
    let fileOffset = 0;
    const fileData = new DataView(this.toArrayBuffer(contents)); // Reading in Big Endian

    const hunkHeader = fileData.getUint32(fileOffset, false);
    fileOffset += 4;
    if (hunkHeader !== HunkType.HEADER) {
      throw new Error(
        "Not a valid hunk file : Unable to find correct HUNK_HEADER"
      );
    } else {
      // Skip header/string section
      fileOffset += 4;

      const tableSize = fileData.getUint32(fileOffset, false);
      fileOffset += 4;
      const firstHunk = fileData.getUint32(fileOffset, false);
      fileOffset += 4;
      const lastHunk = fileData.getUint32(fileOffset, false);
      fileOffset += 4;

      if (tableSize < 0 || firstHunk < 0 || lastHunk < 0) {
        throw new Error("Not a valid hunk file : Invalid sizes for hunks");
      }

      const hunkCount = lastHunk - firstHunk + 1;

      const hunkTable = new Array<SizesTypes>();

      for (let i = 0; i < hunkCount; i++) {
        const [size, memType] = this.getSizeType(
          fileData.getUint32(fileOffset, false)
        );
        this.logger.log(`Hunk found [${MemoryType[memType]}] size = ${size}`);
        fileOffset += 4;
        hunkTable.push({
          memType: memType,
          size: size,
        });
      }

      const hunks: Hunk[] = [];

      for (let i = 0; i < hunkCount; i++) {
        const hunk: Hunk = {
          index: i,
          fileOffset: fileOffset,
          memType: hunkTable[i].memType,
          allocSize: hunkTable[i].size,
        };
        this.logger.log(`____ Parsing Hunk index #${i}`);
        fileOffset = this.fillHunk(hunk, fileData, fileOffset);
        this.logHunk(hunk);
        hunks.push(hunk);
      }
      return hunks;
    }
  }

  public async readFile(fileUri: Uri): Promise<Array<Hunk>> {
    this.logger.log(`Parsing file "${fileUri.fsPath}"`);
    const buffer = await readFile(fileUri.fsPath);
    return this.parseFile(buffer);
  }
}
