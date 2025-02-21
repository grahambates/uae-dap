import { logger, Source, StackFrame } from "@vscode/debugadapter";
import { basename } from "path";
import { DisassemblyManager } from "./disassembly";
import { DEFAULT_FRAME_INDEX, GdbClient } from "./gdbClient";
import { REGISTER_PC_INDEX } from "./registers";
import SourceMap from "./sourceMap";
import { formatHexadecimal } from "./utils/strings";

export interface StackPosition {
  index: number;
  stackFrameIndex: number;
  pc: number;
}

class StackManager {
  constructor(
    private gdb: GdbClient,
    private sourceMap: SourceMap,
    private disassembly: DisassemblyManager
  ) {}

  /**
   * Get stack trace for thread
   */
  public async getStackTrace(
    threadId: number,
    stackPositions: StackPosition[]
  ): Promise<StackFrame[]> {
    const stackFrames = [];

    for (const p of stackPositions) {
      let sf: StackFrame | undefined;

      if (p.pc >= 0) {
        try {
          const location = this.sourceMap.lookupAddress(p.pc);
          const source = new Source(basename(location.path), location.path);
          sf = new StackFrame(
            p.index,
            location.symbol ?? "__MAIN__",
            source,
            location.line
          );
          sf.instructionPointerReference = formatHexadecimal(p.pc);
        } catch (_) {
          // Will get processed with disassembler
        }
      }

      // Get disassembled stack frame if not set
      if (!sf) {
        sf = await this.disassembly.getStackFrame(p, threadId);
      }
      stackFrames.push(sf);
    }

    return stackFrames;
  }

  public async getPositions(threadId: number): Promise<StackPosition[]> {
    const stackPositions: StackPosition[] = [];
    let stackPosition = await this.getStackPosition(
      threadId,
      DEFAULT_FRAME_INDEX
    );
    stackPositions.push(stackPosition);
    // Retrieve the current frame count
    const stackSize = await this.gdb.getFramesCount();
    for (let i = stackSize - 1; i >= 0; i--) {
      try {
        stackPosition = await this.getStackPosition(threadId, i);
        stackPositions.push(stackPosition);
      } catch (err) {
        if (err instanceof Error) logger.error(err.message);
      }
    }
    return stackPositions;
  }

  public async getStackPosition(
    threadId: number,
    frameIndex = DEFAULT_FRAME_INDEX
  ): Promise<StackPosition> {
    logger.log("Getting position at frame " + frameIndex);
    // Get the current frame
    return this.gdb.withFrame(frameIndex, async (index) => {
      const pc = await this.gdb.getRegister(REGISTER_PC_INDEX);
      if (pc) {
        return {
          index: frameIndex,
          stackFrameIndex: index + 1,
          pc: pc,
        };
      } else {
        throw new Error(
          "Error retrieving stack frame for index " +
            frameIndex +
            ": pc not retrieved"
        );
      }
    });
    throw new Error("No frames for thread: " + threadId);
  }
}

export default StackManager;
