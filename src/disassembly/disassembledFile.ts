export interface DisassembledFile {
  path?: string;
  segmentId?: number;
  stackFrameIndex?: number;
  address?: number;
  length?: number;
  copper?: boolean;
}

/**
 * Create file path for DisassembledFile
 */
export function disassembledFileToPath(file: DisassembledFile): string {
  const address = file.address?.toString(16);
  const path = file.path ?? "";
  if (file.segmentId !== undefined) {
    return `${path}seg_${file.segmentId}.dbgasm`;
  }
  if (file.copper) {
    return `${path}copper_$${address}__${file.length}.dbgasm`;
  }
  return `${path}${file.stackFrameIndex}__$${address}__${file.length}.dbgasm`;
}

/**
 * Check if path is for a disassembled file
 */
export function isDisassembledFile(path: string): boolean {
  return path.endsWith(".dbgasm");
}

/**
 * Create a DisassembledFile from a path string
 *
 * Extracts properties from tokens in filename.
 */
export function disassembledFileFromPath(path: string): DisassembledFile {
  const segMatch = path.match(/^(?<path>.+\/)?seg_(?<segmentId>[^_]+).dbgasm$/);
  if (segMatch?.groups) {
    const { path = "", segmentId } = segMatch.groups;
    return {
      path,
      segmentId: parseInt(segmentId),
      copper: false,
    };
  }

  const copperMatch = path.match(
    /^(?<path>.+\/)?copper_\$(?<address>[^_]+)__(?<length>[^_]+).dbgasm$/
  );
  if (copperMatch?.groups) {
    const { path = "", address, length } = copperMatch.groups;
    return {
      path,
      address: parseInt(address, 16),
      length: parseInt(length),
      copper: true,
    };
  }

  const addressMatch = path.match(
    /^(?<path>.+\/)?(?<frame>[^_]+)__\$(?<address>[^_]+)__(?<length>[^_]+).dbgasm$/
  );
  if (addressMatch?.groups) {
    const { path = "", frame, address, length } = addressMatch.groups;
    return {
      path,
      stackFrameIndex: parseInt(frame),
      address: parseInt(address, 16),
      length: parseInt(length),
      copper: false,
    };
  }

  throw new Error("Unrecognised filename format " + path);
}
