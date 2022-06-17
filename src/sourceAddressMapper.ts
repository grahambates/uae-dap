import { Hunk } from "./amigaHunkParser";

export interface FileLocation {
  filename: string;
  line: number;
}

/**
 * Source address mapper
 *
 * Once we know the addresses of the segments in RAM, this allows us to translate between source locations and memory
 * addresses using hunk data
 */
export class SourceAddressMapper {
  private locationMap = new Map<string, Map<number, number>>();
  private addressMap = new Map<number, FileLocation>();

  constructor(hunks: Hunk[], hunkOffsets: number[]) {
    for (const hunk of hunks) {
      const hunkOffset = hunkOffsets[hunk.index];
      if (hunk.lineDebugInfo) {
        for (const info of hunk.lineDebugInfo) {
          const filename = info.sourceFilename;
          let fileMap = this.locationMap.get(info.sourceFilename);
          if (!fileMap) {
            fileMap = new Map<number, number>();
            this.locationMap.set(info.sourceFilename, fileMap);
          }
          for (const { line, offset } of info.lines) {
            fileMap.set(line, offset + hunkOffset);

            const address = offset + hunkOffset;
            this.addressMap.set(address, { line, filename });
          }
        }
      }
    }
  }

  locationToAddress(filename: string, line: number): number | undefined {
    return this.locationMap.get(filename)?.get(line);
  }

  addressToLocation(address: number): FileLocation | undefined {
    // TODO: non-exact match between lines
    return this.addressMap.get(address);
  }

  sourceFiles(): string[] {
    return Array.from(this.locationMap.keys());
  }
}
