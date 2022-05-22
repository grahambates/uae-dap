import { OutputEvent } from "@vscode/debugadapter/lib/main";
import { DebugProtocol } from "@vscode/debugprotocol/lib/debugProtocol";
import { GdbProxyWinUAE, GdbProxy } from "./gdb";
import { LaunchRequestArguments, FsUAEDebugSession } from "./debugSession";
import { BreakpointManager } from "./breakpointManager";
import { ScopeType } from "./program";

export class WinUAEDebugSession extends FsUAEDebugSession {
  protected createGdbProxy(): GdbProxy {
    return new GdbProxyWinUAE(undefined);
  }

  protected async connect(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    return new Promise((resolve) => {
      const timeoutValue = this.testMode ? 1 : 3000;

      setTimeout(async () => {
        // connects to WinUAE
        try {
          await this.gdb.connect(args.serverName, args.serverPort);
          // Loads the program
          this.sendEvent(new OutputEvent(`Starting program: ${args.program}`));
          await this.gdb.initProgram();
          const thread = this.gdb.getCurrentCpuThread();
          if (thread) {
            if (args.stopOnEntry) {
              await this.gdb.stepIn(thread);
              await this.breakpoints.sendAllPendingBreakpoints();
            } else {
              await this.breakpoints.sendAllPendingBreakpoints();
              await this.gdb.continueExecution(thread);
            }
            this.sendResponse(response);
          }
        } catch (err) {
          this.sendStringErrorResponse(response, (err as Error).message);
        } finally {
          resolve();
        }
      }, timeoutValue);
    });
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    const thread = this.gdb.getThread(args.threadId);
    if (thread) {
      try {
        const [frame] = await this.gdb.stack(thread);
        const startAddress = frame.pc;
        const endAddress = frame.pc;
        await this.gdb.stepToRange(thread, startAddress, endAddress);
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "Unknown thread");
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    const thread = this.gdb.getThread(args.threadId);
    if (thread) {
      try {
        const stk = await this.gdb.stack(thread);
        if (stk.length > 0) {
          const frame = stk[1];
          const bpArray = this.breakpoints.createTemporaryBreakpointArray([
            frame.pc + 1,
            frame.pc + 2,
            frame.pc + 4,
          ]);
          await this.breakpoints.addTemporaryBreakpointArray(bpArray);
          await this.gdb.continueExecution(thread);
          this.sendResponse(response);
        } else {
          this.sendStringErrorResponse(response, "No frame to step out");
        }
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "Unknown thread");
    }
  }

  protected async getVariableAsDisplayed(
    variableName: string
  ): Promise<string> {
    this.ensureProgramLoaded(this.program);
    const vars = await this.program.getVariables();
    const value = vars[variableName];
    return this.program.formatVariable(variableName, value);
  }

  protected async dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments
  ): Promise<void> {
    if (args.variablesReference !== undefined && args.name) {
      this.ensureProgramLoaded(this.program);
      const { type } = this.program.getScopeReference(args.variablesReference);
      if (type === ScopeType.Symbols || type === ScopeType.Registers) {
        const variableName = args.name;
        const displayValue = await this.getVariableAsDisplayed(variableName);
        this.breakpoints.populateDataBreakpointInfoResponseBody(
          response,
          variableName,
          displayValue,
          type === ScopeType.Registers
        );
      }
    }
    this.sendResponse(response);
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments
  ): Promise<void> {
    const debugBreakPoints: DebugProtocol.Breakpoint[] = [];
    // clear all breakpoints for this file
    await this.breakpoints.clearDataBreakpoints();
    // set and verify breakpoint locations
    if (args.breakpoints) {
      for (const reqBp of args.breakpoints) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_, displayValue, value] = this.breakpoints.parseDataIdAddress(
          reqBp.dataId
        );
        const size =
          BreakpointManager.getSizeForDataBreakpoint(reqBp.dataId) ?? 2;
        const debugBp = this.breakpoints.createDataBreakpoint(
          value,
          size,
          reqBp.accessType,
          `${size} bytes watched starting at ${displayValue}`
        );
        try {
          const modifiedBp = await this.breakpoints.setBreakpoint(debugBp);
          debugBreakPoints.push(modifiedBp);
        } catch (err) {
          debugBreakPoints.push(debugBp);
        }
      }
      // send back the actual breakpoint positions
      response.body = {
        breakpoints: debugBreakPoints,
      };
      response.success = true;
    }
    this.sendResponse(response);
  }
}
