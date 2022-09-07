import {
  InitializedEvent,
  TerminatedEvent,
  OutputEvent,
  InvalidatedEvent,
  logger,
  LoggingDebugSession,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { LogLevel } from "@vscode/debugadapter/lib/logger";

import { BreakpointCode, GdbClient, HaltSignal, HaltStatus } from "./gdbClient";
import { BreakpointManager } from "./breakpoints";
import {
  base64ToHex,
  formatAddress,
  formatHexadecimal,
  hexToBase64,
  NumberFormat,
  replaceAsync,
} from "./utils/strings";
import { Emulator } from "./emulator";
import Program, {
  MemoryFormat,
  ScopeType,
  SourceConstantResolver,
} from "./program";
import { VasmOptions, VasmSourceConstantResolver } from "./vasm";
import { parseHunksFromFile } from "./amigaHunkParser";
import SourceMap from "./sourceMap";
import { REGISTER_COPPER_ADDR_INDEX, REGISTER_PC_INDEX } from "./registers";

export const THREAD_ID_CPU = 1;
export const THREAD_ID_COPPER = 2;

export interface StackPosition {
  index: number;
  stackFrameIndex: number;
  pc: number;
}

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

export class UAEDebugSession extends LoggingDebugSession {
  protected gdb: GdbClient;
  protected emulator: Emulator;
  protected testMode = false;
  protected trace = false;
  protected exceptionMask?: number;
  protected breakpoints?: BreakpointManager;
  protected program?: Program;

  public constructor() {
    super();
    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    this.emulator = new Emulator();
    this.gdb = new GdbClient();
  }

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
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ) {
    const {
      program,
      exceptionMask = 0b111100,
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

      this.trace = trace;
      logger.init((e) => this.sendEvent(e));
      logger.setup(trace ? LogLevel.Verbose : LogLevel.Error);

      if (!this.testMode) {
        this.sendHelpText();
      }

      if (startEmulator) {
        if (!emulator || !emulatorOptions) {
          throw new Error("Missing emulator configuration");
        }
        logger.log(
          `Starting emulator: ${emulator} ${emulatorOptions.join(" ")}`
        );
        await this.emulator.run({
          executable: emulator,
          args: emulatorOptions,
          cwd: emulatorWorkingDir,
          onExit: () => this.sendEvent(new TerminatedEvent()),
        });
      }

      // Delay before connecting to emulator
      if (!this.testMode) {
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }

      // Connect to the emulator
      logger.log(`Connecting to remote debugger...`);
      await this.gdb.connect(serverName, serverPort);
      logger.log("Connected");

      for (const threadId of [THREAD_ID_CPU, THREAD_ID_COPPER]) {
        this.sendEvent({
          event: "thread",
          body: {
            reason: "started",
            threadId,
          },
        } as DebugProtocol.Event); // TODO: why missing props?
      }

      if (stopOnEntry) {
        logger.log("Stopping on entry");
        this.sendStoppedEvent(THREAD_ID_CPU, "entry");
        await this.gdb.stepIn(THREAD_ID_CPU);
      }

      const [offsets, hunks] = await Promise.all([
        this.gdb.getOffsets(),
        parseHunksFromFile(program),
      ]);

      this.gdb.on("stop", this.handleStop.bind(this));
      this.gdb.on("end", this.shutdown.bind(this));

      const sourceMap = new SourceMap(hunks, offsets);

      this.program = new Program(
        this.gdb,
        sourceMap,
        this.getSourceConstantResolver(args),
        {
          ...defaultMemoryFormats,
          ...memoryFormats,
        }
      );

      // Set up breakpoints:
      this.breakpoints = new BreakpointManager(this.gdb, sourceMap);
      this.gdb.setExceptionBreakpoint(exceptionMask);
      this.exceptionMask = exceptionMask;

      this.sendEvent(new InitializedEvent());

      if (!stopOnEntry) {
        await this.gdb.continueExecution(THREAD_ID_CPU);
      }

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
      const content = await this.getProgram().getDisassembledFileContentsByPath(
        fileReq.path
      );
      response.body = { content };
      return this.sendResponse(response);
    }
    if (command === "modifyVariableFormat") {
      const variableReq: VariableDisplayFormatRequest = args;
      this.getProgram().setVariableFormat(
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
      const instructions = await this.getProgram().disassemble(args);
      await Promise.all(
        instructions.map(({ location }) => this.processSource(location))
      );
      response.body = { instructions };
    });
  }

  // Breakpoints:

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const breakpoints = await this.getBreakpoints().setSourceBreakpoints(
        args.source,
        args.breakpoints || []
      );
      response.body = { breakpoints };
      response.success = true;
    });
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const breakpoints = await this.getBreakpoints().setInstructionBreakpoints(
        args.breakpoints
      );
      response.body = { breakpoints };
      response.success = true;
    });
  }

  protected async dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      if (!args.variablesReference || !args.name) {
        return;
      }
      const program = this.getProgram();
      const { type } = program.getScopeReference(args.variablesReference);
      if (type === ScopeType.Symbols || type === ScopeType.Registers) {
        const variableName = args.name;
        const vars = await program.getVariables();
        const value = vars[variableName];
        if (typeof value === "number") {
          const displayValue = program.formatVariable(variableName, value);

          const isRegister = type === ScopeType.Registers;
          const dataId = `${variableName}(${displayValue})`;

          response.body = {
            dataId,
            description: isRegister ? `${displayValue}` : dataId,
            accessTypes: ["read", "write", "readWrite"],
            canPersist: true,
          };
        }
      }
    });
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      const breakpoints = await this.getBreakpoints().setDataBreakpoints(
        args.breakpoints
      );
      response.body = { breakpoints };
      response.success = true;
    });
  }

  protected async setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      if (this.exceptionMask) {
        if (args.filters.length > 0) {
          await this.gdb.setExceptionBreakpoint(this.exceptionMask);
        } else {
          // TODO: check this
          await this.gdb.removeBreakpoint(
            this.exceptionMask,
            BreakpointCode.HARDWARE
          );
        }
      }
      response.success = true;
    });
  }

  protected async exceptionInfoRequest(
    response: DebugProtocol.ExceptionInfoResponse
  ) {
    this.handleAsyncRequest(response, async () => {
      const haltStatus = await this.gdb.getHaltStatus();
      if (haltStatus) {
        response.body = {
          exceptionId: haltStatus.code.toString(),
          description: haltStatus.details,
          breakMode: "always",
        };
      }
    });
  }

  protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
    response.body = {
      threads: [
        { id: THREAD_ID_CPU, name: "cpu" },
        { id: THREAD_ID_COPPER, name: "copper" },
      ],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    { threadId }: DebugProtocol.StackTraceArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const positions = await this.getStack(threadId);

      if (threadId === THREAD_ID_CPU && positions[0]) {
        this.getBreakpoints().checkTemporaryBreakpoints(positions[0].pc);
      }

      const stackFrames = await this.getProgram().getStackTrace(
        threadId,
        positions
      );
      await Promise.all(
        stackFrames.map(({ source }) => this.processSource(source))
      );

      response.body = { stackFrames, totalFrames: positions.length };
    });
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

  // Variables:

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      // Try to look up stored reference
      const variables = await this.getProgram().getVariablesByReference(
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
      const newValue = await this.getProgram().setVariable(
        variablesReference,
        name,
        value
      );
      response.body = {
        value: newValue,
      };
    });
  }

  // Navigation:

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    { threadId }: DebugProtocol.PauseArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      await this.gdb.pause(threadId);
      this.sendStoppedEvent(threadId, "pause", false);
    });
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    { threadId }: DebugProtocol.ContinueArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      await this.gdb.continueExecution(threadId);
      response.body = { allThreadsContinued: true };
    });
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    { threadId }: DebugProtocol.NextArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      const [frame] = await this.getStack(threadId);
      await this.gdb.stepToRange(threadId, frame.pc, frame.pc);
      this.sendStoppedEvent(threadId, "step");
    });
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    { threadId }: DebugProtocol.StepInArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      await this.gdb.stepIn(threadId);
      this.sendStoppedEvent(threadId, "step");
    });
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    { threadId }: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.handleAsyncRequest(response, async () => {
      const positions = await this.getStack(threadId);
      if (positions[1]) {
        await this.getBreakpoints().addTemporaryBreakpoints(positions[1].pc);
        await this.gdb.continueExecution(threadId);
      }
    });
  }

  // Memory:

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const address = parseInt(args.memoryReference);
      // await this.gdb.waitConnected();
      let size = 0;
      let memory = "";
      const DEFAULT_CHUNK_SIZE = 1000;
      let remaining = args.count;
      while (remaining > 0) {
        let chunkSize = DEFAULT_CHUNK_SIZE;
        if (remaining < chunkSize) {
          chunkSize = remaining;
        }
        memory += await this.gdb.readMemory(address + size, chunkSize);
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
      // await this.gdb.waitConnected();
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
        await this.gdb.writeMemory(
          address,
          hexString.substring(size, chunkSize)
        );
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
      const body = await this.getProgram().evaluateExpression(args);
      if (body) {
        response.body = body;
      } else {
        response.body = { result: "", variablesReference: 0 };
        this.sendHelpText();
      }
    });
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const targets = await this.getProgram().getCompletions(
        args.text,
        args.frameId
      );
      response.body = { targets };
    });
  }

  private async handleStop(haltStatus: HaltStatus) {
    logger.log(`[EVT] Stopped ${JSON.stringify(haltStatus)}`);
    const threadId = haltStatus.threadId ?? THREAD_ID_CPU;

    if (haltStatus.code !== HaltSignal.TRAP) {
      this.sendStoppedEvent(threadId, "exception", false);
      return;
    }

    const { pc, stackFrameIndex } = await this.getStackPosition(threadId, -1);

    const sourceBpRef = this.getBreakpoints().sourceBreakpointAtAddress(pc);

    // Check for conditional or log breakpoints:
    let stop = true;

    if (sourceBpRef) {
      logger.log(
        `[EVT] Matched source breakpoint at address ${formatAddress(pc)}`
      );
      const bp = sourceBpRef.breakpoint;
      if (bp.logMessage) {
        // Interpolate variables
        const message = await replaceAsync(
          bp.logMessage,
          /\{((#\{((#\{[^}]*\})|[^}])*\})|[^}])*\}/g, // Up to two levels of nesting
          async (match) => {
            try {
              const v = await this.getProgram().evaluate(
                match.substring(1, match.length - 1),
                stackFrameIndex
              );
              return formatHexadecimal(v, 0);
            } catch {
              return "#error";
            }
          }
        );
        this.output(message + "\n");
        stop = false;
      }
      if (bp.condition) {
        const result = await this.getProgram().evaluate(
          bp.condition,
          stackFrameIndex
        );
        const stop = !!result;
        logger.log(
          `[EVT] Evaluated conditional breakpoint ${bp.condition} = ${stop}`
        );
      }
      if (bp.hitCondition) {
        const evaluatedCondition = await this.getProgram().evaluate(
          bp.hitCondition,
          stackFrameIndex
        );
        if (++sourceBpRef.hitCount === evaluatedCondition) {
          logger.log(`[EVT] Hit count reached: ${evaluatedCondition}`);
          this.gdb.removeBreakpoint(pc);
        } else {
          logger.log(
            `[EVT] Hit count not reached: ${sourceBpRef.hitCount}/${evaluatedCondition}`
          );
          stop = false;
        }
      }
    }

    if (stop) {
      logger.log(`[EVT] stopping at breakpoint`);
      this.sendStoppedEvent(threadId, "breakpoint", false);
    } else {
      await this.gdb.continueExecution(threadId);
    }
  }

  public shutdown(): void {
    logger.log(`Shutting down`);
    this.gdb.destroy();
    this.emulator.destroy();
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

  private async getStack(threadId: number): Promise<StackPosition[]> {
    const stackPositions: StackPosition[] = [];
    let stackPosition = await this.getStackPosition(threadId, -1);
    stackPositions.push(stackPosition);
    if (threadId === THREAD_ID_CPU) {
      const currentIndex = stackPosition.stackFrameIndex;
      for (let i = currentIndex; i > 0; i--) {
        stackPosition = await this.getStackPosition(threadId, i);
        stackPositions.push(stackPosition);
      }
    }
    return stackPositions;
  }

  private async getStackPosition(
    threadId: number,
    frameIndex: number
  ): Promise<StackPosition> {
    const stackFrameIndex = await this.gdb.selectFrame(frameIndex);
    if (threadId === THREAD_ID_CPU) {
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
  }

  private getBreakpoints(): BreakpointManager {
    if (!this.breakpoints) {
      throw new Error("Breakpoints not initialized");
    }
    return this.breakpoints;
  }

  private getProgram(): Program {
    if (!this.program) {
      throw new Error("Program not initialized");
    }
    return this.program;
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
