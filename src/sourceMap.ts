import { Hunk } from "./amigaHunkParser";
import { Segment } from "./gdbClient";

export interface Location {
  label?: string;
  path: string;
  line: number;
}

class SourceMap {
  constructor(private hunks: Hunk[], private segments: Segment) {}

  public lookupAddress(address: number): Location | null {
    return null;
  }

  public lookupLocation(location: Location): number | null {
    return null;
  }
}

export default SourceMap;
