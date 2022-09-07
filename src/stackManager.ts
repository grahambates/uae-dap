import { Source, StackFrame } from "@vscode/debugadapter";
import { basename } from "path";
import { DisassemblyManager } from "./disassembly";
import { GdbClient } from "./gdbClient";
import { Threads } from "./hardware";
import { REGISTER_COPPER_ADDR_INDEX, REGISTER_PC_INDEX } from "./registers";
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
        const location = this.sourceMap?.lookupAddress(p.pc);
        if (location) {
          const source = new Source(basename(location.path), location.path);
          sf = new StackFrame(
            p.index,
            location.symbol ?? "__MAIN__",
            source,
            location.line
          );
          sf.instructionPointerReference = formatHexadecimal(p.pc);
        }
      }

      // Get disassembled stack frame if not set
      if (!sf) {
        sf = await this.disassembly.getStackFrame(p, threadId);
      }
      // Only include frames with a source, but make sure we have at least one frame
      // Others are likely to be ROM system calls
      if (sf.source || !stackFrames.length) {
        stackFrames.push(sf);
      }
    }

    return stackFrames;
  }

  public async getPositions(threadId: number): Promise<StackPosition[]> {
    const stackPositions: StackPosition[] = [];
    let stackPosition = await this.getStackPosition(threadId, -1);
    stackPositions.push(stackPosition);
    if (threadId === Threads.CPU) {
      const currentIndex = stackPosition.stackFrameIndex;
      for (let i = currentIndex; i > 0; i--) {
        stackPosition = await this.getStackPosition(threadId, i);
        stackPositions.push(stackPosition);
      }
    }
    return stackPositions;
  }

  public async getStackPosition(
    threadId: number,
    frameIndex: number
  ): Promise<StackPosition> {
    return this.gdb.withFrame(frameIndex, async (stackFrameIndex) => {
      if (threadId === Threads.CPU) {
        // Get the current frame
        const pc = await this.gdb.getRegister(REGISTER_PC_INDEX);
        return {
          index: frameIndex,
          stackFrameIndex,
          pc,
        };
      } else {
        // Retrieve the stack position from the copper
        const haltStatuses = [await this.gdb.getHaltStatus()];
        let finished = false;
        while (!finished) {
          const status = await this.gdb.getVStopped();
          if (status) {
            haltStatuses.push(status);
          } else {
            finished = true;
          }
        }

        for (const hs of haltStatuses) {
          if (hs?.threadId === threadId) {
            const pc = await this.gdb.getRegister(REGISTER_COPPER_ADDR_INDEX);
            return {
              index: frameIndex * 1000,
              stackFrameIndex: 0,
              pc,
            };
          }
        }
      }
      throw new Error("No frames for thread: " + threadId);
    });
  }
}

export default StackManager;
