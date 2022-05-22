import {
  InitializedEvent,
  TerminatedEvent,
  BreakpointEvent,
  Source,
  DebugSession,
  OutputEvent,
  ContinuedEvent,
  InvalidatedEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { basename } from "path";
import promiseRetry from "promise-retry";

import { GdbProxy, GdbHaltStatus, GdbThread } from "./gdb";
import { BreakpointManager } from "./breakpointManager";
import { base64ToHex, hexToBase64, NumberFormat } from "./utils/strings";
import { Emulator } from "./emulator";
import Program, { SourceConstantResolver } from "./program";
import { VasmOptions, VasmSourceConstantResolver } from "./vasm";

export interface LaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments {
  /** An absolute path to the "program" to debug. */
  program: string;
  /** Automatically stop target after launch. If not specified, target does not stop. */
  stopOnEntry?: boolean;
  /** enable logging the Debug Adapter Protocol */
  trace?: boolean;
  /** Host name of the server */
  serverName: string;
  /** Port of the server */
  serverPort: number;
  /** Start emulator */
  startEmulator: boolean;
  /** emulator program */
  emulator?: string;
  /** emulator working directory */
  emulatorWorkingDir?: string;
  /** Emulator options */
  emulatorOptions: string[];
  /** path replacements for source files */
  sourceFileMap?: Record<string, string>;
  /** root paths for sources */
  rootSourceFileMap?: string[];
  /** default exception's mask */
  exceptionMask?: number;
  /** Options for vasm assembler */
  vasm?: VasmOptions;
}

export interface VariableDisplayFormatRequest {
  /** info of the variable */
  variableInfo: { variable: { name: string; value: string } };
  /** Requested format */
  format: NumberFormat;
}

export class FsUAEDebugSession extends DebugSession {
  /** Timeout of the mutex */
  protected static readonly MUTEX_TIMEOUT = 100000;

  /** Loaded program */
  protected program?: Program;
  /** Proxy to Gdb */
  protected gdb: GdbProxy;
  /** Breakpoint manager */
  protected breakpoints: BreakpointManager;
  /** Emulator instance */
  protected emulator: Emulator;
  /** Test mode activated */
  protected testMode = false;
  /** trace the communication protocol */
  protected trace = false;
  /** Track which threads are stopped to avoid invalid events */
  protected stoppedThreads: boolean[] = [false, false];

  /**
   * Creates a new debug adapter that is used for one debug session.
   * We configure the default implementation of a debug adapter here.
   */
  public constructor() {
    super();
    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    this.emulator = new Emulator();
    this.gdb = new GdbProxy();
    this.gdb.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
    this.initProxy();
    this.breakpoints = new BreakpointManager(this.gdb);
    this.breakpoints.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
  }

  /**
   * Setting the context to run the tests.
   * @param gdbProxy mocked proxy
   */
  public setTestContext(gdbProxy: GdbProxy, emulator: Emulator): void {
    this.testMode = true;
    this.gdb = gdbProxy;
    this.emulator = emulator;
    this.gdb.setMutexTimeout(1000);
    this.initProxy();
    this.breakpoints = new BreakpointManager(this.gdb);
    this.breakpoints.setMutexTimeout(1000);
  }

  /**
   * Initialize proxy
   */
  public initProxy(): void {
    // setup event handlers
    this.gdb.on("stopOnEntry", (threadId) => {
      this.sendStoppedEvent(threadId, "entry", false);
    });
    this.gdb.on("stopOnStep", (threadId, preserveFocusHint) => {
      // Only send step events for stopped threads
      if (this.stoppedThreads[threadId]) {
        this.sendStoppedEvent(threadId, "step", preserveFocusHint);
      }
    });
    this.gdb.on("stopOnPause", (threadId) => {
      // Only send pause evens for running threads
      if (!this.stoppedThreads[threadId]) {
        this.sendStoppedEvent(threadId, "pause", false);
      }
    });
    this.gdb.on("stopOnBreakpoint", (threadId) => {
      // Only send breakpoint evens for running threads
      if (!this.stoppedThreads[threadId]) {
        this.sendStoppedEvent(threadId, "breakpoint", false);
      }
    });
    this.gdb.on("stopOnException", (_, threadId) => {
      this.sendStoppedEvent(threadId, "exception", false);
    });
    this.gdb.on("continueThread", (threadId, allThreadsContinued) => {
      this.stoppedThreads[threadId] = false;
      this.sendEvent(new ContinuedEvent(threadId, allThreadsContinued));
    });
    this.gdb.on("segmentsUpdated", (segments) =>
      this.program?.updateSegments(segments)
    );
    this.gdb.on("breakpointValidated", (bp) => {
      // Dirty workaround to issue https://github.com/microsoft/vscode/issues/65993
      setTimeout(async () => {
        try {
          this.sendEvent(new BreakpointEvent("changed", bp));
        } catch (error) {
          // forget it
        }
      }, 100);
    });
    this.gdb.on("threadStarted", (threadId) => {
      const event = <DebugProtocol.ThreadEvent>{
        event: "thread",
        body: {
          reason: "started",
          threadId: threadId,
        },
      };
      this.sendEvent(event);
    });
    this.gdb.on("output", (text, filePath, line, column) => {
      if (this.trace) {
        const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
        if (filePath !== undefined) {
          e.body.source = new Source(
            basename(filePath),
            this.convertDebuggerPathToClient(filePath)
          );
        }
        if (line !== undefined) {
          e.body.line = this.convertDebuggerLineToClient(line);
        }
        if (column !== undefined) {
          e.body.column = this.convertDebuggerColumnToClient(column);
        }
        this.sendEvent(e);
      }
    });
    this.gdb.on("end", this.terminate.bind(this));
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse
  ): void {
    // build and return the capabilities of this debug adapter:
    response.body = {
      ...response.body,
      supportsCompletionsRequest: true,
      supportsConditionalBreakpoints: false,
      supportsConfigurationDoneRequest: false,
      supportsDataBreakpoints: true,
      supportsDisassembleRequest: true,
      supportsEvaluateForHovers: true,
      supportsExceptionInfoRequest: true,
      supportsExceptionOptions: true,
      supportsInstructionBreakpoints: true,
      supportsReadMemoryRequest: true,
      supportsRestartFrame: false,
      supportsSetVariable: true,
      supportsStepBack: false,
      supportsSteppingGranularity: false,
      supportsValueFormattingOptions: true,
      supportsWriteMemoryRequest: true,
      exceptionBreakpointFilters: [
        {
          filter: "all",
          label: "All Exceptions",
          default: true,
        },
      ],
    };

    this.sendResponse(response);

    // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
    // we request them early by sending an 'initializeRequest' to the frontend.
    // The frontend will end the configuration sequence by calling 'configurationDone' request.
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ) {
    try {
      if (!args.program) {
        throw new Error("Missing program argument in launch request");
      }

      this.program = await Program.create(
        args.program,
        this.gdb,
        args.sourceFileMap,
        args.rootSourceFileMap,
        this.getSourceConstantResolver(args)
      );

      this.breakpoints.setProgram(this.program);
      this.breakpoints.checkPendingBreakpointsAddresses();
      if (args.exceptionMask) {
        this.breakpoints.setExceptionMask(args.exceptionMask);
      }

      this.trace = args.trace ?? false;

      if (!this.testMode) {
        this.sendHelpText();
      }

      if (args.startEmulator) {
        await this.emulator.run({
          executable: args.emulator,
          args: args.emulatorOptions,
          cwd: args.emulatorWorkingDir,
          onExit: () => this.sendEvent(new TerminatedEvent()),
        });
      }

      let retries = 30;

      // Delay before connecting to emulator
      if (!this.testMode) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        retries = 0;
      }

      // Connect to the emulator
      const { serverName = "localhost", serverPort = 6860 } = args;
      await promiseRetry(
        (retry) => this.gdb.connect(serverName, serverPort).catch(retry),
        { minTimeout: 500, retries, factor: 1.1 }
      );

      // Load the program
      this.sendEvent(new OutputEvent(`Starting program: ${args.program}`));
      await this.gdb.load(args.program, args.stopOnEntry);

      this.sendResponse(response);
    } catch (err) {
      this.sendEvent(new TerminatedEvent());
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected getSourceConstantResolver(
    args: LaunchRequestArguments
  ): SourceConstantResolver {
    return new VasmSourceConstantResolver(args.vasm);
  }

  protected sendHelpText() {
    const text = `Commands:
    Memory dump:
        m address|\${register|symbol}|#{symbol},size[, wordSizeInBytes, rowSizeInWords][,ab]
        			a: show ascii output, b: show bytes output
            example: m $5c50,10,2,4
    Disassembled Memory dump:
        m address|\${register|symbol}|#{symbol},size,d
            example: m \${pc},10,d
    Disassembled Copper Memory dump:
        m address|\${register|symbol}|#{symbol},size,c
            example: m \${copperlist},16,c
    Memory set:
        M address|\${register|symbol}|#{symbol}=bytes
            example: M $5c50=0ff534
    \${symbol} gives the address of symbol
    #{symbol} gives the pointed value from the symbols
`;
    this.sendEvent(new OutputEvent(text));
  }

  protected async customRequest(
    command: string,
    response: DebugProtocol.Response,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any
  ) {
    if (command === "disassembleInner") {
      return this.disassembleRequest(response, args);
    }
    if (command === "modifyVariableFormat") {
      const variableReq: VariableDisplayFormatRequest = args;
      this.program?.setVariableFormat(
        variableReq.variableInfo.variable.name,
        variableReq.format
      );
      this.sendEvent(new InvalidatedEvent(["variables"]));
      return this.sendResponse(response);
    }
    super.customRequest(command, response, args);
  }

  protected async disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      assertIsDefined(this.program);
      const instructions = await this.program.disassemble(args);
      // Convert source paths:
      instructions.forEach((i) => {
        if (i.location?.path)
          i.location.path = this.convertDebuggerPathToClient(i.location.path);
      });
      response.body = { instructions };
    });
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const breakpoints: DebugProtocol.Breakpoint[] = [];
      await this.breakpoints.clearInstructionBreakpoints();
      // set and verify breakpoint locations
      if (args.breakpoints) {
        for (const reqBp of args.breakpoints) {
          const debugBp = this.breakpoints.createInstructionBreakpoint(
            parseInt(reqBp.instructionReference)
          );
          try {
            const modifiedBp = await this.breakpoints.setBreakpoint(debugBp);
            breakpoints.push(modifiedBp);
          } catch (err) {
            breakpoints.push(debugBp);
          }
        }
      }
      response.body = { breakpoints };
      response.success = true;
    });
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      // clear all breakpoints for this file
      await this.breakpoints.clearBreakpoints(args.source);
      // set and verify breakpoint locations
      const breakpoints = args.breakpoints
        ? await Promise.all(
            args.breakpoints.map(async ({ line }) => {
              const bp = this.breakpoints.createBreakpoint(args.source, line);
              return this.breakpoints.setBreakpoint(bp).catch(() => bp);
            })
          )
        : [];
      // send back the actual breakpoint positions
      response.body = { breakpoints };
      response.success = true;
    });
  }

  protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
    this.handleAsyncRequest(response, async () => {
      assertIsDefined(this.program);
      const threads = await this.program.getThreads();
      response.body = { threads };
    });
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      const positions = await this.gdb.stack(thread);

      // Update the cpu view
      for (const f of positions) {
        if (this.gdb.isCPUThread(thread)) {
          this.updateDisassembledView(f.pc);
          this.breakpoints.checkTemporaryBreakpoints(f.pc);
          break;
        }
      }

      assertIsDefined(this.program);
      const stackFrames = await this.program.getStackTrace(thread, positions);
      response.body = { stackFrames, totalFrames: positions.length };
      // Convert source paths:
      response.body.stackFrames.forEach((f) => {
        if (f.source?.path)
          f.source.path = this.convertDebuggerPathToClient(f.source.path);
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async updateDisassembledView(_: number) {
    // NOOP on this implementation- needed for vs-code
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    { frameId }: DebugProtocol.ScopesArguments
  ): void {
    this.handleAsyncRequest(response, async () => {
      response.body = {
        scopes: this.program?.getScopes(frameId) ?? [],
      };
    });
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      assertIsDefined(this.program);
      // Try to look up stored reference
      const variables = await this.program.getVariablesByReference(
        args.variablesReference
      );
      response.body = { variables };
    });
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    { variablesReference, name, value }: DebugProtocol.SetVariableArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      assertIsDefined(this.program);
      const newValue = await this.program.setVariable(
        variablesReference,
        name,
        value
      );
      response.body = {
        value: newValue,
      };
    });
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      await this.gdb.continueExecution(thread);
      response.body = { allThreadsContinued: false };
    });
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      await this.gdb.stepToRange(thread, 0, 0);
    });
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      await this.gdb.stepIn(thread);
    });
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      const positions = await this.gdb.stack(thread);
      const { pc } = positions[1];
      await this.gdb.stepToRange(thread, pc + 1, pc + 10);
    });
  }

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const address = parseInt(args.memoryReference);
      await this.gdb.waitConnected();
      let size = 0;
      let memory = "";
      const DEFAULT_CHUNK_SIZE = 1000;
      let remaining = args.count;
      while (remaining > 0) {
        let chunkSize = DEFAULT_CHUNK_SIZE;
        if (remaining < chunkSize) {
          chunkSize = remaining;
        }
        memory += await this.gdb.getMemory(address + size, chunkSize);
        remaining -= chunkSize;
        size += chunkSize;
      }
      let unreadable = args.count - size;
      if (unreadable < 0) {
        unreadable = 0;
      }
      response.body = {
        address: address.toString(16),
        data: hexToBase64(memory),
      };
    });
  }

  protected async writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      let address = parseInt(args.memoryReference);
      if (args.offset) {
        address += args.offset;
      }
      await this.gdb.waitConnected();
      const hexString = base64ToHex(args.data);
      const count = hexString.length;
      const DEFAULT_CHUNK_SIZE = 1000;
      let remaining = count;
      let size = 0;
      while (remaining > 0) {
        let chunkSize = DEFAULT_CHUNK_SIZE;
        if (remaining < chunkSize) {
          chunkSize = remaining;
        }
        await this.gdb.setMemory(address, hexString.substring(size, chunkSize));
        remaining -= chunkSize;
        size += chunkSize;
      }
      response.body = {
        bytesWritten: size,
      };
    });
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      assertIsDefined(this.program);
      response.body = await this.program.evaluateExpression(args);
    });
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const thread = await this.getThread(args.threadId);
      await this.gdb.pause(thread);
    });
  }

  protected async exceptionInfoRequest(
    response: DebugProtocol.ExceptionInfoResponse
  ) {
    this.handleAsyncRequest(response, async () => {
      await this.gdb.waitConnected();
      const haltStatus = await this.gdb.getHaltStatus();
      let selectedHs: GdbHaltStatus = haltStatus[0];
      for (const hs of haltStatus) {
        if (hs.thread && this.gdb.isCPUThread(hs.thread)) {
          selectedHs = hs;
          break;
        }
      }
      response.body = {
        exceptionId: selectedHs.code.toString(),
        description: selectedHs.details,
        breakMode: "always",
      };
    });
  }

  protected async setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      if (args.filters.length > 0) {
        await this.breakpoints.setExceptionBreakpoint();
      } else {
        await this.breakpoints.removeExceptionBreakpoint();
      }
      response.success = true;
    });
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      assertIsDefined(this.program);
      const vars = await this.program.getVariables(args.frameId);
      response.body = {
        targets: Object.keys(vars)
          .filter((key) => key.startsWith(args.text))
          .map((label) => ({ label })),
      };
    });
  }

  public terminate(): void {
    this.gdb.destroy();
    this.emulator.destroy();
  }

  public shutdown(): void {
    this.terminate();
  }

  protected async getThread(threadId: number): Promise<GdbThread> {
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(threadId);
    if (!thread) {
      throw new Error("Unknown thread");
    }
    return thread;
  }

  protected ensureProgramLoaded(
    program: Program | undefined
  ): asserts program is Program {
    if (program === undefined) {
      throw new Error("Program not running");
    }
  }

  protected async handleAsyncRequest(
    response: DebugProtocol.Response,
    cb: () => Promise<void>
  ) {
    try {
      await cb();
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected sendStoppedEvent(
    threadId: number,
    reason: string,
    preserveFocusHint?: boolean
  ) {
    this.stoppedThreads[threadId] = true;
    this.sendEvent(<DebugProtocol.StoppedEvent>{
      event: "stopped",
      body: {
        reason: reason,
        threadId: threadId,
        preserveFocusHint: preserveFocusHint,
        allThreadsStopped: true,
      },
    });
  }

  protected sendStringErrorResponse(
    response: DebugProtocol.Response,
    message: string
  ): void {
    response.success = false;
    response.message = message;
    this.sendResponse(response);
  }
}

function assertIsDefined<T>(val: T): asserts val is NonNullable<T> {
  if (val === undefined || val === null) {
    throw new Error(`Expected 'val' to be defined, but received ${val}`);
  }
}
