import {
  InitializedEvent,
  TerminatedEvent,
  BreakpointEvent,
  Source,
  DebugSession,
  OutputEvent,
  ContinuedEvent,
  InvalidatedEvent,
  logger,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { LogLevel } from "@vscode/debugadapter/lib/logger";
import { basename } from "path";
import promiseRetry from "promise-retry";

import {
  GdbProxy,
  GdbHaltStatus,
  GdbThread,
  isSourceBreakpoint,
  isDataBreakpoint,
} from "./gdb";
import { BreakpointManager } from "./breakpoints";
import {
  base64ToHex,
  formatHexadecimal,
  hexToBase64,
  NumberFormat,
  replaceAsync,
} from "./utils/strings";
import { Emulator } from "./emulator";
import Program, { MemoryFormat, SourceConstantResolver } from "./program";
import { VasmOptions, VasmSourceConstantResolver } from "./vasm";
import { FileInfo } from "./fileInfo";

export interface LaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments {
  /** An absolute path to the "program" to debug. */
  program: string;
  /** Automatically stop target after launch. If not specified, target does not stop. */
  stopOnEntry?: boolean;
  /** enable logging the Debug Adapter Protocol */
  trace?: boolean;
  /** Host name of the server */
  serverName?: string;
  /** Port of the server */
  serverPort?: number;
  /** Start emulator */
  startEmulator?: boolean;
  /** emulator program */
  emulator?: string;
  /** emulator working directory */
  emulatorWorkingDir?: string;
  /** Emulator options */
  emulatorOptions?: string[];
  /** path replacements for source files */
  sourceFileMap?: Record<string, string>;
  /** root paths for sources */
  rootSourceFileMap?: string[];
  /** default exception's mask */
  exceptionMask?: number;
  /** Options for vasm assembler */
  vasm?: VasmOptions;
  /** Display format per context */
  memoryFormats?: Record<string, MemoryFormat>;
}

export interface VariableDisplayFormatRequest {
  /** info of the variable */
  variableInfo: { variable: DebugProtocol.Variable };
  /** Requested format */
  variableDisplayFormat: NumberFormat;
}

export interface DisassembledFileContentsRequest {
  /** path of dbgasm file */
  path: string;
}

export const defaultMemoryFormats = {
  watch: {
    length: 104,
    wordLength: 2,
  },
  hover: {
    length: 24,
    wordLength: 2,
  },
};

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
    this.gdb = this.createGdbProxy();
    this.gdb.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
    this.initProxy();
    this.breakpoints = new BreakpointManager(this.gdb);
    this.breakpoints.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
  }

  protected createGdbProxy(): GdbProxy {
    return new GdbProxy();
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
    this.gdb.on("stopOnBreakpoint", async (threadId) => {
      // Only send breakpoint events for running threads
      if (this.stoppedThreads[threadId]) {
        return;
      }
      // Should we send a stop message to the client?
      // May want to cancel for conditional or log breakpoints
      let stop = true;

      // Check for conditional or log breakpoints:

      // Find the breakpoint that was hit
      // first need to get the source line from the stack trace
      const thread = await this.getThread(threadId);
      const positions = await this.gdb.stack(thread);
      assertIsDefined(this.program);
      const [fr] = await this.program.getStackTrace(thread, positions);
      // get the breakpoint at this source location:
      const bp = this.breakpoints.findSourceBreakpoint(fr?.source, fr?.line);

      if (bp && (isSourceBreakpoint(bp) || isDataBreakpoint(bp))) {
        if (bp.logMessage) {
          // Interpolate variables
          const message = await replaceAsync(
            bp.logMessage,
            /\{((#\{((#\{[^}]*\})|[^}])*\})|[^}])*\}/g, // Up to two levels of nesting
            (match) => {
              assertIsDefined(this.program);
              return this.program
                .evaluate(match.substring(1, match.length - 1), fr.id)
                .then((v) => formatHexadecimal(v, 0))
                .catch(() => "#error");
            }
          );
          this.output(message + "\n");
          stop = false;
        } else if (bp.condition) {
          const result = await this.program.evaluate(bp.condition, fr.id);
          stop = !!result;
        } else if (bp.hitCondition) {
          const result = await this.program.evaluate(bp.hitCondition, fr.id);
          if (++bp.hitCount === result) {
            this.breakpoints.removeBreakpoint(bp);
          } else {
            stop = false;
          }
        }
      }

      // Send stop event or resume execution
      if (stop) {
        this.sendStoppedEvent(threadId, "breakpoint", false);
      } else {
        this.gdb.continueExecution(thread);
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
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsLogPoints: true,
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
    const {
      program,
      sourceFileMap,
      rootSourceFileMap,
      exceptionMask,
      serverName = "localhost",
      serverPort = 6860,
      startEmulator = true,
      stopOnEntry = false,
      emulator,
      emulatorOptions = [],
      emulatorWorkingDir,
      trace = false,
      memoryFormats,
    } = args;

    try {
      if (!program) {
        throw new Error("Missing program argument in launch request");
      }

      const fileInfo = await FileInfo.create(
        program,
        sourceFileMap,
        rootSourceFileMap
      );

      this.program = new Program(
        this.gdb,
        fileInfo,
        this.getSourceConstantResolver(args),
        {
          ...defaultMemoryFormats,
          ...memoryFormats,
        }
      );

      this.breakpoints.setProgram(this.program);
      this.breakpoints.addLocationToPending();
      if (exceptionMask) {
        this.breakpoints.setExceptionMask(exceptionMask);
      }

      this.trace = trace;
      logger.init((e) => this.sendEvent(e));
      logger.setup(trace ? LogLevel.Verbose : LogLevel.Error);

      if (!this.testMode) {
        this.sendHelpText();
      }

      if (startEmulator) {
        if (!emulator) {
          throw new Error("Missing emulator argument in launch request");
        }
        await this.emulator.run({
          executable: emulator,
          args: emulatorOptions,
          cwd: emulatorWorkingDir,
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
      await promiseRetry(
        (retry) => this.gdb.connect(serverName, serverPort).catch(retry),
        { minTimeout: 500, retries, factor: 1.1 }
      );

      // Load the program
      this.output(`Starting program: ${program}\n`);
      this.startProgram(program, stopOnEntry);

      this.sendResponse(response);
    } catch (err) {
      this.sendEvent(new TerminatedEvent());
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async startProgram(program: string, stopOnEntry: boolean) {
    await this.gdb.load(program, stopOnEntry);
  }

  protected getSourceConstantResolver(
    args: LaunchRequestArguments
  ): SourceConstantResolver {
    return new VasmSourceConstantResolver(args.vasm);
  }

  protected sendHelpText() {
    const text = `Commands:
  Memory dump:
    m address[,size=16,wordSizeInBytes=4,rowSizeInWords=4][,ab]
      a: show ascii output, b: show bytes output (default: both)
      examples: m $5c50,10              Dump 10 bytes of memory starting at $5c50
                m a0,DATA_SIZE,2,4,a    DATA_SIZE bytes in rows of 4 words from
  Disassemble:
    d address[,size=16]
      example: d pc,10                  Disassemble 10 bytes of memory starting
  Disassemble copper:
    c address[,size=16]
      example: c copperlist,16          Disassemble 16 bytes of memory as copper
  Memory set:
    M address=bytes
      bytes: unprefixed hexadecimal literal
      example: M $5c50=0ff534           Write 3 byte value to memory address $5c50
  * All parameters can be expressions unless specified.

Expressions:
  Expression syntax can be evaluated here in the console, as well as in watch, conditional breakpoints and logpoints.
  It uses a JavaScript-like syntax and can reference variables from the Registers, Symbols and Constants groups.

  Numeric literals can use either JavaScript or ASM style base prefixes:
    decimal (default), hex (0x or $), octal (0o or @) or binary (ob or %)
  Operators supported:
    Arithmetic: + - / * ** % ++ --
    Bitwise:    & | ~ ^ << >>
    Comparison: < <= > >= == !=
    Logical:    && || !
    Ternary:    ? :
  Memory references:
    Allow you to reference values from memory. Reads a numeric value from an address, which can be an expression.
    Read unsigned:
      @(address[,size=4])
        size: number of bytes to read
        example: @($100)               Unsigned longword value at address $100
    Read signed:
      @s(address[,size=4])
        example: @s(a0,2)              Signed word value at address in register a0
`;
    this.output(text);
  }

  protected sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments
  ): void {
    this.handleAsyncRequest(response, async () => {
      const content = await this.program?.getDisassembledFileContentsByRef(
        args.sourceReference
      );
      if (!content) {
        throw new Error("Source not found");
      }
      response.body = { content };
    });
  }

  protected async customRequest(
    command: string,
    response: DebugProtocol.Response,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any
  ) {
    if (command === "disassembledFileContents") {
      const fileReq: DisassembledFileContentsRequest = args;
      assertIsDefined(this.program);
      const content = await this.program.getDisassembledFileContentsByPath(
        fileReq.path
      );
      response.body = { content };
      return this.sendResponse(response);
    }
    if (command === "modifyVariableFormat") {
      const variableReq: VariableDisplayFormatRequest = args;
      assertIsDefined(this.program);
      this.program.setVariableFormat(
        variableReq.variableInfo.variable.name,
        variableReq.variableDisplayFormat
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
      await Promise.all(
        instructions.map(({ location }) => this.processSource(location))
      );
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
          const bp = this.breakpoints.createInstructionBreakpoint(
            parseInt(reqBp.instructionReference)
          );
          await this.breakpoints.setBreakpoint(bp);
          breakpoints.push(bp);
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
            args.breakpoints.map(async (reqBp) => {
              const bp = this.breakpoints.createBreakpoint(args.source, reqBp);
              await this.breakpoints.setBreakpoint(bp);
              return bp;
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
      assertIsDefined(this.program);
      const thread = await this.getThread(args.threadId);
      const positions = await this.gdb.stack(thread);

      if (this.gdb.isCPUThread(thread) && positions[0]) {
        this.onCpuFrame(positions[0].pc);
      }

      const stackFrames = await this.program.getStackTrace(thread, positions);
      await Promise.all(
        stackFrames.map(({ source }) => this.processSource(source))
      );

      response.body = { stackFrames, totalFrames: positions.length };
    });
  }

  /**
   * Hook to perform actions when entering a new CPU stack frame
   */
  protected async onCpuFrame(address: number) {
    this.breakpoints.checkTemporaryBreakpoints(address);
  }

  /**
   * Process a Source object before returning in to the client
   */
  protected async processSource(source?: DebugProtocol.Source) {
    // Ensure path is in correct format for client
    if (source?.path) {
      source.path = this.convertDebuggerPathToClient(source.path);
    }
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
      const body = await this.program.evaluateExpression(args);
      if (body) {
        response.body = body;
      } else {
        response.body = { result: "", variablesReference: 0 };
        this.sendHelpText();
      }
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
      const targets = await this.program.getCompletions(
        args.text,
        args.frameId
      );
      response.body = { targets };
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
      let message = "Unknown error";
      if (err instanceof Error) {
        const showStack = this.trace || this.testMode;
        // Display stack trace in trace mode
        message = showStack ? err.stack ?? err.message : err.message;
      }
      this.sendStringErrorResponse(response, message);
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
        reason,
        threadId,
        preserveFocusHint,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected output(output: string, category = "console", data?: any) {
    const e = new OutputEvent(output, category, data);
    this.sendEvent(e);
  }
}

function assertIsDefined<T>(val: T): asserts val is NonNullable<T> {
  if (val === undefined || val === null) {
    throw new Error(`Expected 'val' to be defined, but received ${val}`);
  }
}
