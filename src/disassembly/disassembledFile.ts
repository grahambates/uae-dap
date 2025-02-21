export interface DisassembledFile {
  memoryReference?: string;
  instructionCount?: number;
  /** Segment ID */
  segmentId?: number;
  /** Stack frame index */
  stackFrameIndex?: number;
}

/**
 * Create file path for DisassembledFile
 */
export function disassembledFileToPath(file: DisassembledFile): string {
  const address = file.memoryReference;
  if (file.segmentId !== undefined) {
    return `seg_${file.segmentId}.dbgasm`;
  }
  return `${file.stackFrameIndex}__${address}__${file.instructionCount}.dbgasm`;
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
    const { segmentId } = segMatch.groups;
    return {
      segmentId: parseInt(segmentId),
    };
  }

  const addressMatch = path.match(
    /^(?<path>.+\/)?(?<frame>[^_]+)__(?<memoryReference>[^_]+)__(?<instructionCount>[^_]+).dbgasm$/
  );
  if (addressMatch?.groups) {
    const { frame, memoryReference, instructionCount } = addressMatch.groups;
    return {
      stackFrameIndex: parseInt(frame),
      memoryReference,
      instructionCount: parseInt(instructionCount),
    };
  }

  throw new Error("Unrecognised filename format " + path);
}
