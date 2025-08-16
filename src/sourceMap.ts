import { MemoryType } from "./amigaHunkParser";
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

export class SourceMap {
  private locationsBySource = new Map<string, Map<number, Location>>();
  private locationsByAddress = new Map<number, Location>();

  constructor(
    private segments: Segment[],
    private sources: Set<string>,
    private symbols: Record<string, number>,
    locations: Location[]
  ) {
    for (const location of locations) {
      this.locationsByAddress.set(location.address, location);
      const pathKey = location.path.toUpperCase();
      const linesMap =
        this.locationsBySource.get(pathKey) || new Map<number, Location>();
      linesMap.set(location.line, location);
      this.locationsBySource.set(pathKey, linesMap);
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
