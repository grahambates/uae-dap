import { DebugProtocol } from "@vscode/debugprotocol/lib/debugProtocol";
import { GdbProxyWinUAE, GdbProxy } from "./gdb";
import { FsUAEDebugSession } from "./debugSession";
import { BreakpointStorage, BreakpointStorageMap } from "./breakpoints";
import { ScopeType } from "./program";

export class WinUAEDebugSession extends FsUAEDebugSession {
  protected createGdbProxy(): GdbProxy {
    return new GdbProxyWinUAE(undefined);
  }

  protected async startProgram(_: string, stopOnEntry: boolean): Promise<void> {
    await this.gdb.initProgram();
    const thread = this.gdb.getCurrentCpuThread();
    if (thread) {
      if (stopOnEntry) {
        await this.gdb.stepIn(thread);
        await this.breakpoints.sendAllPendingBreakpoints();
      } else {
        await this.breakpoints.sendAllPendingBreakpoints();
        await this.gdb.continueExecution(thread);
      }
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      const [frame] = await this.gdb.stack(thread);
      const startAddress = frame.pc;
      const endAddress = frame.pc;
      await this.gdb.stepToRange(thread, startAddress, endAddress);
    });
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      const positions = await this.gdb.stack(thread);
      if (positions.length <= 0) {
        throw new Error("No frame to step out");
      }
      const { pc } = positions[1];
      const bpArray = this.breakpoints.createTemporaryBreakpointArray([
        pc + 1,
        pc + 2,
        pc + 4,
      ]);
      await this.breakpoints.addTemporaryBreakpointArray(bpArray);
      await this.gdb.continueExecution(thread);
    });
  }

  protected async dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      if (!args.variablesReference || args.name) {
        return;
      }
      this.ensureProgramLoaded(this.program);
      const { type } = this.program.getScopeReference(args.variablesReference);
      if (type === ScopeType.Symbols || type === ScopeType.Registers) {
        const variableName = args.name;
        const vars = await this.program.getVariables();
        const value = vars[variableName];
        const displayValue = this.program.formatVariable(variableName, value);

        const isRegister = type === ScopeType.Registers;
        const dataId = `${variableName}(${displayValue})`;

        response.body = {
          dataId,
          description: isRegister ? `${displayValue}` : dataId,
          accessTypes: ["read", "write", "readWrite"],
          canPersist: true,
        };
      }
    });
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      const breakpoints: DebugProtocol.Breakpoint[] = [];
      // clear all breakpoints for this file
      await this.breakpoints.clearDataBreakpoints();
      // set and verify breakpoint locations
      if (!args.breakpoints) {
        return;
      }
      for (const reqBp of args.breakpoints) {
        const { name, displayValue, value } = this.parseDataIdAddress(
          reqBp.dataId
        );
        const size = await this.getDataBreakpointSize(
          reqBp.dataId,
          displayValue,
          name
        );
        const bp = this.breakpoints.createDataBreakpoint(
          value,
          size,
          reqBp.accessType,
          `${size} bytes watched starting at ${displayValue}`
        );
        await this.breakpoints.setBreakpoint(bp);
        breakpoints.push(bp);
      }
      // send back the actual breakpoint positions
      response.body = { breakpoints };
      response.success = true;
    });
  }

  private parseDataIdAddress(dataId: string): {
    name: string;
    displayValue: string;
    value: number;
  } {
    const match = dataId.match(/(?<name>.+)\((?<displayValue>.+)\)/);
    if (!match?.groups) {
      throw new Error("DataId format invalid");
    }
    const { name, displayValue } = match.groups;
    return {
      name,
      displayValue,
      value: parseInt(displayValue),
    };
  }

  protected getBreakpointStorage(): BreakpointStorage {
    return new BreakpointStorageMap();
  }

  protected async getDataBreakpointSize(
    id: string,
    _address: string,
    _variable: string
  ): Promise<number> {
    return this.getBreakpointStorage().getSize(id) ?? 2;
  }
}
