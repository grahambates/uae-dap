import { Hunk, MemoryType } from "./amigaHunkParser";
import { normalize } from "path";

export interface Location {
  path: string;
  line: number;
  symbol?: string;
  symbolOffset?: number;
  address: number;
  segmentIndex: number;
  segmentOffset: number;
}

export interface Segment {
  name: string;
  address: number;
  size: number;
  memType: MemoryType;
}

class SourceMap {
  private segments: Segment[];
  private sources = new Set<string>();
  private symbols: Record<string, number> = {};
  private locationsBySource = new Map<string, Map<number, Location>>();
  private locationsByAddress = new Map<number, Location>();

  constructor(hunks: Hunk[], offsets: number[]) {
    this.segments = offsets.map((address, i) => {
      const hunk = hunks[i];
      return {
        address,
        name: `Seg${i}_${hunk.hunkType}_${hunk.memType}`,
        size: hunk.dataSize ?? hunk.allocSize,
        memType: hunk.memType,
      };
    });

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const hunk = hunks[i];

      for (const { offset, name } of hunk.symbols) {
        this.symbols[name] = seg.address + offset;
      }

      // Add first source from each hunk
      // This should be the entry point. Others files may be includes.
      if (hunk.lineDebugInfo[0]) {
        this.sources.add(normalize(hunk.lineDebugInfo[0].sourceFilename));
      }

      for (const debugInfo of hunk.lineDebugInfo) {
        const path = normalize(debugInfo.sourceFilename);
        const pathKey = path.toUpperCase();
        const linesMap =
          this.locationsBySource.get(pathKey) || new Map<number, Location>();
        for (const lineInfo of debugInfo.lines) {
          const address = seg.address + debugInfo.baseOffset + lineInfo.offset;
          let symbol;
          let symbolOffset;
          for (const { offset, name } of hunk.symbols) {
            if (offset > lineInfo.offset) break;
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
        this.locationsBySource.set(pathKey, linesMap);
      }
    }
  }

  public getSourceFiles(): string[] {
    return Array.from(this.sources.values());
  }

  public getSegmentsInfo(): Segment[] {
    return this.segments;
  }

  public getSymbols(): Record<string, number> {
    return this.symbols;
  }

  public lookupAddress(address: number): Location {
    let location = this.locationsByAddress.get(address);
    if (!location) {
      for (const [a, l] of this.locationsByAddress.entries()) {
        if (a > address) break;
        if (address - a <= 10) location = l;
      }
    }
    if (!location) {
      throw new Error("Location not found for address " + address);
    }
    return location;
  }

  public lookupSourceLine(path: string, line: number): Location {
    const pathKey = normalize(path).toUpperCase();
    const fileMap = this.locationsBySource.get(pathKey);
    if (!fileMap) {
      throw new Error("File not found in source map: " + path);
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

  public getSegmentInfo(segmentId: number): Segment {
    const segment = this.segments[segmentId];
    if (!segment) {
      throw new Error("Invalid segment: " + segmentId);
    }
    return segment;
  }
}

export default SourceMap;
