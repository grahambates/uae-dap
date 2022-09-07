import { Hunk, HunkType, MemoryType } from "./amigaHunkParser";
import { normalize } from "./utils/files";

export interface Location {
  path: string;
  line: number;
  symbol?: string;
  symbolOffset?: number;
  address: number;
  segmentIndex: number;
  segmentOffset: number;
}

export interface SegmentInfo {
  name: string;
  address: number;
  size: number;
  memType: MemoryType;
}

class SourceMap {
  private segmentsInfo: SegmentInfo[];
  private sources: string[] = [];
  private symbols: Record<string, number> = {};
  private locationsBySource = new Map<string, Map<number, Location>>();
  private locationsByAddress = new Map<number, Location>();

  constructor(hunks: Hunk[], offsets: number[]) {
    this.segmentsInfo = offsets.map((address, i) => {
      const hunk = hunks[i];
      return {
        address,
        name: `Seg${i}_${hunk.hunkType}_${hunk.memType}`,
        size: hunk.dataSize ?? hunk.allocSize,
        memType: hunk.memType,
      };
    });

    for (let i = 0; i < this.segmentsInfo.length; i++) {
      const seg = this.segmentsInfo[i];
      const hunk = hunks[i];

      for (const { offset, name } of hunk.symbols) {
        this.symbols[name] = seg.address + offset;
      }

      for (const debugInfo of hunk.lineDebugInfo) {
        const path = normalize(debugInfo.sourceFilename);
        const linesMap =
          this.locationsBySource.get(path) || new Map<number, Location>();
        for (const lineInfo of debugInfo.lines) {
          const address = seg.address + debugInfo.baseOffset + lineInfo.offset;
          let symbol;
          let symbolOffset;
          for (const { offset, name } of hunk.symbols) {
            if (lineInfo.offset > offset) break;
            symbol = name;
            symbolOffset = lineInfo.offset - offset;
          }
          const location: Location = {
            path,
            line: lineInfo.line,
            symbol,
            symbolOffset,
            segmentIndex: i,
            segmentOffset: lineInfo.offset,
            address,
          };
          linesMap.set(lineInfo.line, location);
          this.locationsByAddress.set(address, location);
        }
        this.locationsBySource.set(path, linesMap);
      }
    }
  }

  public getSourceFiles(): string[] {
    return this.sources;
  }

  public getSegmentsInfo(): SegmentInfo[] {
    return this.segmentsInfo;
  }

  public getSymbols(): Record<string, number> {
    return this.symbols;
  }

  public lookupAddress(address: number): Location {
    let location = this.locationsByAddress.get(address);
    if (!location) {
      for (const [a, l] of this.locationsByAddress.entries()) {
        if (a > address) break;
        location = l;
      }
    }
    if (!location) {
      throw new Error("Location not found for address " + address);
    }
    return location;
  }

  public lookupSourceLine(path: string, line: number): Location {
    const normalizedPath = normalize(path);
    const fileMap = this.locationsBySource.get(normalizedPath);
    if (!fileMap) {
      throw new Error("File not found in source map: " + normalizedPath);
    }
    let location = fileMap.get(line);
    if (!location) {
      for (const [ln, loc] of fileMap.entries()) {
        if (ln > line) break;
        location = loc;
      }
    }
    if (!location) {
      throw new Error("Location not found for line " + line);
    }
    return location;
  }

  public getSegmentInfo(segmentId: number): SegmentInfo {
    const segment = this.segmentsInfo[segmentId];
    if (!segment) {
      throw new Error("Invalid segment: " + segmentId);
    }
    return segment;
  }
}

export default SourceMap;
