import {
  logger,
  InitializedEvent,
  TerminatedEvent,
  OutputEvent,
  InvalidatedEvent,
  LoggingDebugSession,
  ThreadEvent,
} from "@vscode/debugadapter";
import { LogLevel } from "@vscode/debugadapter/lib/logger";
import { DebugProtocol } from "@vscode/debugprotocol";

import {
  GdbClient,
  HaltSignal,
  HaltStatus,
  DEFAULT_FRAME_INDEX,
} from "./gdbClient";
import BreakpointManager, { BreakpointReference } from "./breakpointManager";
import {
  base64ToHex,
  formatAddress,
  formatHexadecimal,
  hexToBase64,
  NumberFormat,
  replaceAsync,
} from "./utils/strings";
import { Emulator } from "./emulator";
import VariableManager, {
  MemoryFormat,
  ScopeType,
  SourceConstantResolver,
} from "./variableManager";
import { VasmOptions, VasmSourceConstantResolver } from "./vasm";
import { parseHunksFromFile } from "./amigaHunkParser";
import SourceMap from "./sourceMap";
import { DisassemblyManager } from "./disassembly";
import { Threads } from "./hardware";
import StackManager from "./stackManager";
import promiseRetry from "promise-retry";
import { Mutex } from "./utils/mutex";

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
  /** Emulator CLI args */
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

const defaultArgs = {
  exceptionMask: 0b111100,
  serverName: "localhost",
  serverPort: 6860,
  startEmulator: true,
  stopOnEntry: false,
  emulatorOptions: [],
  trace: false,
  memoryFormats: {
    watch: {
      length: 104,
      wordLength: 2,
    },
    hover: {
      length: 24,
      wordLength: 2,
    },
  },
};

export class UAEDebugSession extends LoggingDebugSession {
  protected gdb: GdbClient;
  protected emulator: Emulator;

  protected trace = false;
  protected firstStop = true;
  protected stopOnEntry = false;
  protected exceptionMask = defaultArgs.exceptionMask;
  protected pausing = 0;
  protected stepping = 0;

  protected breakpoints?: BreakpointManager;
  protected variables?: VariableManager;
  protected disassembly?: DisassemblyManager;
  protected stack?: StackManager;

  public constructor() {
    super();
    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    this.emulator = new Emulator();
    this.gdb = new GdbClient();
    const mutex = new Mutex(50, 10000);

    this.gdb.on("stop", async (haltStatus) => {
      const unlock = await mutex.capture("stop");
      return this.handleStop(haltStatus).finally(unlock);
    });
    this.gdb.on("end", this.shutdown.bind(this));
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
      supportsConfigurationDoneRequest: true,
      supportsDataBreakpoints: true,
      supportsDisassembleRequest: true,
      supportsEvaluateForHovers: true,
      supportsExceptionInfoRequest: true,
      supportsExceptionOptions: true,
      supportsInstructionBreakpoints: true,
      supportsReadMemoryRequest: true,
      supportsRestartFrame: false,
      supportsSetVariable: true,
      supportsSingleThreadExecutionRequests: false,
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
    customArgs: LaunchRequestArguments
  ) {
    // Merge in default args
    const args = {
      ...defaultArgs,
      ...customArgs,
      memoryFormats: {
        ...defaultArgs.memoryFormats,
        ...customArgs.memoryFormats,
      },
    };

    try {
      if (!args.program) {
        throw new Error("Missing program argument in launch request");
      }
      this.trace = args.trace;
      this.stopOnEntry = args.stopOnEntry;
      this.exceptionMask = args.exceptionMask;
      this.firstStop = true;

      // Initialize logger:
      logger.init((e) => this.sendEvent(e));
      logger.setup(args.trace ? LogLevel.Verbose : LogLevel.Error);

      // Start the emulator
      if (args.startEmulator) {
        if (!args.emulator || !args.emulatorOptions) {
          throw new Error("Missing emulator configuration");
        }
        const opts = args.emulatorOptions.join(" ");
        logger.log(`[LAUNCH] Starting emulator: ${args.emulator} ${opts}`);
        await this.emulator.run({
          executable: args.emulator,
          args: args.emulatorOptions,
          onExit: () => {
            logger.log(`[EMU] Emulator quit`);
            this.sendEvent(new TerminatedEvent());
          },
          onOutput: (data) => {
            logger.log("[EMU] " + data.toString().trim());
          },
        });
      } else {
        logger.log(`[LAUNCH] Not starting emulator`);
      }

      if (args.noDebug) {
        logger.log(`[LAUNCH] Not debugging`);
        return;
      }

      this.gdb.setExceptionBreakpoint(args.exceptionMask);
      this.sendHelpText();

      // Connect to the remote debugger
      await promiseRetry(
        (retry, attempt) => {
          logger.log(`[LAUNCH] Connecting to remote debugger... [${attempt}]`);
          return this.gdb
            .connect(args.serverName, args.serverPort)
            .catch(retry);
        },
        { retries: 20, factor: 1.1 }
      );

      for (const threadId of [Threads.CPU, Threads.COPPER]) {
        this.sendEvent(new ThreadEvent("started", threadId));
      }

      // Get info to Initialize source map
      const [hunks, offsets] = await Promise.all([
        parseHunksFromFile(args.program),
        this.gdb.getOffsets(),
      ]);
      const sourceMap = new SourceMap(hunks, offsets);

      // Initialize managers:
      this.variables = new VariableManager(
        this.gdb,
        sourceMap,
        this.getSourceConstantResolver(customArgs),
        args.memoryFormats
      );
      this.disassembly = new DisassemblyManager(
        this.gdb,
        this.variables,
        sourceMap
      );
      this.breakpoints = new BreakpointManager(
        this.gdb,
        sourceMap,
        this.disassembly
      );
      this.stack = new StackManager(this.gdb, sourceMap, this.disassembly);

      if (args.stopOnEntry) {
        logger.log("[LAUNCH] Stopping on entry");
        await this.gdb.stepIn(Threads.CPU);
      }

      // Tell client that we can now handle breakpoints etc.
      this.sendEvent(new InitializedEvent());
    } catch (err) {
      this.sendEvent(new TerminatedEvent());
      response.success = false;
      response.message = (err as Error).message;
    }

    this.sendResponse(response);
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse
  ) {
    this.handleAsyncRequest(response, async () => {
      if (!this.stopOnEntry) {
        logger.log("Continuing execution after config done");
        await this.gdb.continueExecution(Threads.CPU);
      }
    });
  }

  public shutdown(): void {
    logger.log(`Shutting down`);
    this.gdb.destroy();
    this.emulator.destroy();
  }

  // Breakpoints:

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const breakpoints = await this.breakpointManager().setSourceBreakpoints(
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
      const breakpoints =
        await this.breakpointManager().setInstructionBreakpoints(
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
      const variables = this.variableManager();
      const { type } = variables.getScopeReference(args.variablesReference);
      if (type === ScopeType.Symbols || type === ScopeType.Registers) {
        const variableName = args.name;
        const vars = await variables.getVariables();
        const value = vars[variableName];
        if (typeof value === "number") {
          const displayValue = variables.formatVariable(variableName, value);

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
      const breakpoints = await this.breakpointManager().setDataBreakpoints(
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
        // There is only one filter - "all exceptions" so just use it to toggle on/off
        if (args.filters.length > 0) {
          await this.gdb.setExceptionBreakpoint(this.exceptionMask);
        } else {
          await this.gdb.setExceptionBreakpoint(0);
        }
      }
      response.success = true;
    });
  }

  // Running program info:

  protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
    response.body = {
      threads: [
        { id: Threads.CPU, name: "cpu" },
        { id: Threads.COPPER, name: "copper" },
      ],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    { threadId }: DebugProtocol.StackTraceArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const positions = await this.stackManager().getPositions(threadId);
      if (
        threadId === Threads.CPU &&
        positions[0] &&
        this.breakpointManager().temporaryBreakpointAtAddress(positions[0].pc)
      ) {
        await this.breakpointManager().clearTemporaryBreakpoints();
      }
      const stackFrames = await this.stackManager().getStackTrace(
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
        scopes: this.variableManager().getScopes(frameId),
      };
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

  // Execution flow:

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    { threadId }: DebugProtocol.PauseArguments
  ) {
    this.sendResponse(response);
    this.pausing = threadId;
    await this.gdb.pause(Threads.CPU);
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse) {
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
    this.stepping = 0;
    await this.gdb.continueExecution(Threads.CPU);
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    { threadId }: DebugProtocol.NextArguments
  ): Promise<void> {
    this.sendResponse(response);
    const [frame] = await this.stackManager().getPositions(threadId);
    this.stepping = threadId;
    await this.gdb.stepToRange(threadId, frame.pc, frame.pc);
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    { threadId }: DebugProtocol.StepInArguments
  ) {
    this.sendResponse(response);
    this.stepping = threadId;
    await this.gdb.stepIn(threadId);
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    { threadId }: DebugProtocol.StepOutArguments
  ): Promise<void> {
    const positions = await this.stackManager().getPositions(threadId);
    if (positions[1]) {
      this.sendResponse(response);
      this.stepping = threadId;
      const { pc } = positions[1];
      await this.breakpointManager().addTemporaryBreakpoints(pc);
      await this.gdb.continueExecution(threadId);
    } else {
      logger.error(
        `No previous frame to step out to (stack size: ${positions.length})`
      );
      response.body.success = false;
      this.sendResponse(response);
    }
  }

  // Variables:

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      // Try to look up stored reference
      const variables = await this.variableManager().getVariablesByReference(
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
      const newValue = await this.variableManager().setVariable(
        variablesReference,
        name,
        value
      );
      response.body = {
        value: newValue,
      };
    });
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const body = await this.variableManager().evaluateExpression(args);
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
      const targets = await this.variableManager().getCompletions(
        args.text,
        args.frameId
      );
      response.body = { targets };
    });
  }

  // Memory:

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const address = parseInt(args.memoryReference);
      let size = 0;
      let memory = "";
      const maxChunkSize = 1000;
      let remaining = args.count;
      while (remaining > 0) {
        let chunkSize = maxChunkSize;
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
      const hexString = base64ToHex(args.data);
      const count = hexString.length;
      const maxChunkSize = 1000;
      let remaining = count;
      let size = 0;
      while (remaining > 0) {
        let chunkSize = maxChunkSize;
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

  // Disassembly:

  protected async disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const instructions = await this.disassemblyManager().disassemble(args);
      await Promise.all(
        instructions.map(({ location }) => this.processSource(location))
      );
      response.body = { instructions };
    });
  }

  protected sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments
  ): void {
    this.handleAsyncRequest(response, async () => {
      const content = await this.disassembly?.getDisassembledFileContentsByRef(
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
      const content =
        await this.disassemblyManager().getDisassembledFileContentsByPath(
          fileReq.path
        );
      response.body = { content };
      return this.sendResponse(response);
    }
    if (command === "modifyVariableFormat") {
      const variableReq: VariableDisplayFormatRequest = args;
      this.variableManager().setVariableFormat(
        variableReq.variableInfo.variable.name,
        variableReq.variableDisplayFormat
      );
      this.sendEvent(new InvalidatedEvent(["variables"]));
      return this.sendResponse(response);
    }
    super.customRequest(command, response, args);
  }

  // Internals:

  protected async handleAsyncRequest(
    response: DebugProtocol.Response,
    cb: () => Promise<void>
  ) {
    try {
      await cb();
    } catch (err) {
      if (err instanceof Error) {
        // Display stack trace in trace mode
        response.message = this.trace ? err.stack ?? err.message : err.message;
      }
      response.success = false;
    }
    this.sendResponse(response);
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
        allThreadsStopped: true,
        preserveFocusHint,
      },
    });
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

  /**
   * Event handler for stop/halt event
   */
  protected async handleStop(haltStatus: HaltStatus) {
    logger.log(`[STOP] ${haltStatus.details} [${haltStatus.threadId}]`);

    // Any other halt code other than TRAP must be an exception:
    if (haltStatus.code !== HaltSignal.TRAP) {
      logger.log(`[STOP] Exception`);
      this.sendStoppedEvent(Threads.CPU, "exception");
      return;
    }

    // Special cases where we're waiting for a specific stop event that we triggered:

    if (this.firstStop && this.stopOnEntry) {
      logger.log(`[STOP] Stop on entry`);
      this.firstStop = false;
      this.sendStoppedEvent(Threads.CPU, "entry");
      return;
    }

    if (this.pausing) {
      logger.log(`[STOP] Pause ${this.pausing}`);
      this.sendStoppedEvent(this.pausing, "pause");
      this.pausing = 0;
      return;
    }

    // Get stack position to find current PC address for thread
    const threadId = haltStatus.threadId ?? Threads.CPU;
    const { pc, stackFrameIndex } = await this.stackManager().getStackPosition(
      threadId,
      DEFAULT_FRAME_INDEX
    );

    const manager = this.breakpointManager();

    // Check temporary breakpoints:
    // Are we waiting for a temporary breakpoint?
    if (manager.hasTemporaryBreakpoints()) {
      // Did we hit it or something else?
      if (manager.temporaryBreakpointAtAddress(pc)) {
        logger.log(
          `[STOP] Matched temporary breakpoint at address ${formatAddress(pc)}`
        );
        await manager.clearTemporaryBreakpoints();
        this.sendStoppedEvent(this.stepping, "step");
      } else {
        logger.log(`[STOP] ignoring while waiting for temporary breakpoint`);
        await this.gdb.continueExecution(Threads.CPU);
      }
      return;
    }

    if (this.stepping) {
      if (threadId === this.stepping) {
        logger.log(`[STOP] Step ${this.stepping}`);
        this.sendStoppedEvent(this.stepping, "step");
      } else {
        logger.log(`[STOP] ignoring event on other thread while stepping`);
      }
      return;
    }

    // No special cases met - find the breakpoint at the current address:

    // Check instruction breakpoints:
    if (manager.instructionBreakpointAtAddress(pc)) {
      logger.log(
        `[STOP] Matched instruction breakpoint at address ${formatAddress(pc)}`
      );
      this.sendStoppedEvent(threadId, "instruction breakpoint");
      return;
    }

    // Check source / data breakpoints:
    let ref: BreakpointReference | undefined =
      manager.sourceBreakpointAtAddress(pc);
    let type = "breakpoint";
    if (!ref) {
      ref = manager.dataBreakpointAtAddress(pc);
      type = "data breakpoint";
    }
    if (!ref) {
      logger.log(`[STOP] No breakpoint found at address ${formatAddress(pc)}`);
      return;
    }

    logger.log(`[STOP] Matched ${type} at address ${formatAddress(pc)}`);

    // Decide whether to stop at this breakpoint or continue
    // Needs to check for conditional / log breakpoints etc.
    let shouldStop = true;
    const bp = ref.breakpoint;

    // Log point:
    const logMessage = (bp as DebugProtocol.SourceBreakpoint).logMessage;
    if (logMessage) {
      // Interpolate variables
      const message = await replaceAsync(
        logMessage,
        /\{((#\{((#\{[^}]*\})|[^}])*\})|[^}])*\}/g, // Up to two levels of nesting
        async (match) => {
          try {
            const v = await this.variableManager().evaluate(
              match.substring(1, match.length - 1),
              stackFrameIndex
            );
            return formatHexadecimal(v, 0);
          } catch {
            return "#error";
          }
        }
      );
      this.sendEvent(new OutputEvent(message + "\n", "console"));
      shouldStop = false;
    }

    // Conditional breakpoint:
    if (bp.condition) {
      const result = await this.variableManager().evaluate(
        bp.condition,
        stackFrameIndex
      );
      const stop = !!result;
      logger.log(
        `[STOP] Evaluated conditional breakpoint ${bp.condition} = ${stop}`
      );
    }

    // Hit count:
    if (bp.hitCondition) {
      const evaluatedCondition = await this.variableManager().evaluate(
        bp.hitCondition,
        stackFrameIndex
      );
      logger.log(`[STOP] Hit count: ${ref.hitCount}/${evaluatedCondition}`);
      if (++ref.hitCount === evaluatedCondition) {
        this.gdb.removeBreakpoint(pc);
      } else {
        shouldStop = false;
      }
    }

    if (shouldStop) {
      logger.log(`[STOP] stopping at ${type}`);
      this.sendStoppedEvent(threadId, type);
    } else {
      logger.log(`[STOP] continuing execution`);
      await this.gdb.continueExecution(threadId);
    }
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
    this.sendEvent(new OutputEvent(text, "console"));
  }

  // Allows this to be overridden with another implementation e.g. in VS Code
  protected getSourceConstantResolver(
    args: LaunchRequestArguments
  ): SourceConstantResolver {
    return new VasmSourceConstantResolver(args.vasm);
  }

  // Manager getters:
  // Ensures these are defined i.e. the program is started

  protected breakpointManager(): BreakpointManager {
    if (!this.breakpoints) {
      throw new Error("BreakpointManager not initialized");
    }
    return this.breakpoints;
  }

  protected variableManager(): VariableManager {
    if (!this.variables) {
      throw new Error("VariableManager not initialized");
    }
    return this.variables;
  }

  protected disassemblyManager(): DisassemblyManager {
    if (!this.disassembly) {
      throw new Error("DisassemblyManager not initialized");
    }
    return this.disassembly;
  }

  protected stackManager(): StackManager {
    if (!this.stack) {
      throw new Error("StackManager not initialized");
    }
    return this.stack;
  }
}
