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
import { Mutex } from "async-mutex";
import { basename, dirname } from "path";

import {
  GdbClient,
  HaltSignal,
  HaltEvent,
  DEFAULT_FRAME_INDEX,
} from "./gdbClient";
import BreakpointManager, {
  BreakpointReference,
  DataBreakpointSizes,
} from "./breakpointManager";
import {
  base64ToHex,
  formatAddress,
  formatHexadecimal,
  hexToBase64,
  NumberFormat,
  replaceAsync,
} from "./utils/strings";
import { Emulator, Mame, RunOptions } from "./emulator";
import VariableManager, {
  MemoryFormat,
  ScopeType,
  SourceConstantResolver,
} from "./variableManager";
import { VasmOptions, VasmSourceConstantResolver } from "./vasm";
import { parseVlinkMappingsFile } from "./vlinkMappingsParser";
import SourceMap from "./sourceMap";
import { DisassemblyManager } from "./disassembly";
import { Threads } from "./hardware";
import StackManager from "./stackManager";
import promiseRetry from "promise-retry";
import { helpSummary, commandHelp } from "./help";
import { Section } from "./sections";

/**
 * Additional arguments for launch/attach request
 */
interface CustomArguments {
  /** Local path of a vlink mappings text file */
  mappings?: string;
  /** Automatically stop target after launch (default: false) */
  stopOnEntry?: boolean;
  /** Enable verbose logging (default: false) */
  trace?: boolean;
  /** Host name of the debug server (default: localhost) */
  serverName?: string;
  /** Port number of the debug server (default: 2345) */
  serverPort?: number;
  /** Exception mask (default: 0b111100) */
  exceptionMask?: number;
  /** Options for vasm assembler, used when extracting constants from sources */
  vasm?: VasmOptions;
  /** Display format per context */
  memoryFormats?: Record<string, MemoryFormat>;
}

export interface LaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments,
    CustomArguments {
  /** Path of emulator executable (default: use bundled version) */
  emulatorBin?: string;
  /** Additional CLI args to pass to emulator program. Remote debugger args are added automatically */
  emulatorArgs?: string[];
  /** Local path of ROM */
  program?: string;
}

export interface AttachRequestArguments
  extends DebugProtocol.AttachRequestArguments,
    CustomArguments {}

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

/**
 * Default values for custom launch/attach args
 */
const defaultArgs = {
  program: undefined,
  mappings: undefined,
  remoteProgram: undefined,
  stopOnEntry: false,
  trace: false,
  exceptionMask: 0b111100,
  serverName: "localhost",
  serverPort: 2345,
  emulatorBin: undefined,
  emulatorArgs: [],
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
  protected emulator?: Emulator;

  protected trace = false;
  protected stopOnEntry = false;
  protected exceptionMask = defaultArgs.exceptionMask;

  protected breakpoints?: BreakpointManager;
  protected variables?: VariableManager;
  protected disassembly?: DisassemblyManager;
  protected stack?: StackManager;

  // This can be replaced with a persistent implementation in VS Code
  protected dataBreakpointSizes: DataBreakpointSizes = new Map();

  public constructor() {
    super();

    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    this.gdb = new GdbClient();

    process.on("unhandledRejection", (reason, p) => {
      logger.error(reason + " Unhandled Rejection at Promise " + p);
    });
    process.on("uncaughtException", (err) => {
      logger.error("Uncaught Exception thrown: " + this.errorString(err));
      process.exit(1);
    });

    const mutex = new Mutex();
    this.gdb.on("stop", (haltStatus) => {
      mutex.runExclusive(async () => {
        return this.handleStop(haltStatus).catch((err) => {
          logger.error(this.errorString(err));
        });
      });
    });
    this.gdb.on("end", this.shutdown.bind(this));
    this.gdb.on("output", (msg) => {
      this.sendEvent(new OutputEvent(msg + "\n", "console"));
    });
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
      supportsRestartRequest: true,
      supportsRestartFrame: false,
      supportsSetVariable: true,
      supportsSingleThreadExecutionRequests: false,
      supportsStepBack: false,
      supportsSteppingGranularity: false,
      supportsValueFormattingOptions: true,
      supportsWriteMemoryRequest: true,
      supportsExceptionFilterOptions: false,
      /*
      exceptionBreakpointFilters: [
        {
          filter: "all",
          label: "All Exceptions",
          default: true,
        },
      ],*/
    };
    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    customArgs: LaunchRequestArguments
  ) {
    await this.launchOrAttach(response, customArgs, true, !customArgs.noDebug);
  }

  protected async attachRequest(
    response: DebugProtocol.LaunchResponse,
    customArgs: LaunchRequestArguments
  ) {
    await this.launchOrAttach(response, customArgs, false);
  }

  protected async launchOrAttach(
    response: DebugProtocol.Response,
    customArgs: CustomArguments,
    startEmulator = true,
    debug = true
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
      this.trace = args.trace;
      this.stopOnEntry = args.stopOnEntry;
      this.exceptionMask = args.exceptionMask;

      // Initialize logger:
      logger.init((e) => this.sendEvent(e));
      logger.setup(args.trace ? LogLevel.Verbose : LogLevel.Warn);

      logger.log("[LAUNCH] " + JSON.stringify(args, null, 2));

      // Start the emulator
      if (startEmulator) {
        this.emulator = new Mame();
        // mappings are required when debugging
        if (debug && !args.mappings) {
          throw new Error("Missing mapping argument in launch request");
        }
        if (!args.program) {
          throw new Error("Missing program argument in launch request");
        }

        const runOpts: RunOptions = {
          bin: args.emulatorBin,
          args: args.emulatorArgs,
          rom: basename(args.program),
          rompath: dirname(args.program),
          onExit: () => {
            this.sendEvent(new TerminatedEvent());
          },
        };

        if (debug) {
          await this.emulator.debug({
            ...runOpts,
            serverPort: args.serverPort,
          });
        } else {
          await this.emulator.run(runOpts);
        }
      } else {
        logger.log(`[LAUNCH] Not starting emulator`);
      }

      if (!debug) {
        logger.log(`[LAUNCH] Not debugging`);
        return;
      }

      //      this.sendEvent(new OutputEvent(helpSummary, "console"));

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

      //      this.gdb.setExceptionBreakpoint(args.exceptionMask);

      for (const threadId of [Threads.CPU]) {
        this.sendEvent(new ThreadEvent("started", threadId));
      }

      let sections: Section[] = [];
      if (args.mappings) {
        sections = await parseVlinkMappingsFile(args.mappings);
      }

      const sourceMap = new SourceMap(sections);

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
        this.disassembly,
        this.dataBreakpointSizes
      );
      this.stack = new StackManager(this.gdb, sourceMap, this.disassembly);

      if (args.stopOnEntry) {
        logger.log("[LAUNCH] Stopping on entry");
        await this.gdb.stepIn(Threads.CPU);
        this.sendStoppedEvent(Threads.CPU, "entry");
      }

      // Tell client that we can now handle breakpoints etc.
      this.sendEvent(new InitializedEvent());
    } catch (err) {
      this.sendEvent(new TerminatedEvent());
      response.success = false;
      if (err instanceof Error) {
        response.message = err.message;
      }
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

  protected restartRequest(response: DebugProtocol.RestartResponse) {
    this.handleAsyncRequest(response, async () => {
      await this.gdb.monitor("reset");
    });
  }

  public shutdown(): void {
    logger.log(`Shutting down`);
    this.gdb.destroy();
    this.emulator?.destroy();
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
            description: isRegister ? displayValue : dataId,
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
      for (const i in args.breakpoints) {
        const bp = args.breakpoints[i];
        const { name, displayValue } = this.breakpointManager().parseDataId(
          bp.dataId
        );
        const size = this.dataBreakpointSizes.get(bp.dataId);
        if (!size) {
          const sizeInput = await this.getDataBreakpointSize(
            displayValue,
            name
          );
          this.dataBreakpointSizes.set(bp.dataId, sizeInput);
        }
      }
      const breakpoints = await this.breakpointManager().setDataBreakpoints(
        args.breakpoints
      );
      response.body = { breakpoints };
      response.success = true;
    });
  }
  /*
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
*/
  // Running program info:

  protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
    response.body = {
      threads: [
        { id: Threads.CPU, name: "cpu" },
        /*        { id: Threads.COPPER, name: "copper" },*/
      ],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    { threadId }: DebugProtocol.StackTraceArguments
  ) {
    this.handleAsyncRequest(response, async () => {
      const stack = this.stackManager();
      const positions = await stack.getPositions(threadId);
      const stackFrames = await stack.getStackTrace(threadId, positions);
      stackFrames.map(({ source }) => this.processSource(source));

      if (threadId === Threads.CPU && positions[0]) {
        await this.onCpuFrame(positions[0].pc);
        const breakpoints = this.breakpointManager();
        if (breakpoints.temporaryBreakpointAtAddress(positions[0].pc)) {
          await breakpoints.clearTemporaryBreakpoints();
        }
      }

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
          exceptionId: haltStatus.signal.toString(),
          description: haltStatus.label,
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
    await this.gdb.pause(Threads.CPU);
    this.sendStoppedEvent(threadId, "pause");
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse) {
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
    await this.gdb.continueExecution(Threads.CPU);
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    { threadId }: DebugProtocol.NextArguments
  ): Promise<void> {
    this.sendResponse(response);
    const [frame] = await this.stackManager().getPositions(threadId);
    await this.gdb.stepToRange(threadId, frame.pc, frame.pc);
    this.sendStoppedEvent(threadId, "step");
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    { threadId }: DebugProtocol.StepInArguments
  ) {
    this.sendResponse(response);
    await this.gdb.stepIn(threadId);
    this.sendStoppedEvent(threadId, "step");
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    { threadId }: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.sendResponse(response);
    const positions = await this.stackManager().getPositions(threadId);
    if (positions[1]) {
      // Set a temp breakpoint after PC of prev stack frame
      const { pc } = positions[1];
      await this.breakpointManager().addTemporaryBreakpoints(pc);
      await this.gdb.continueExecution(threadId);
    } else {
      // Step over instead
      const { pc } = positions[0];
      await this.gdb.stepToRange(threadId, pc, pc);
      this.sendStoppedEvent(threadId, "step");
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
      args.expression = args.expression.trim();

      // UAE debug console commands with '$' prefix
      if (args.expression.startsWith("$")) {
        const res = await this.gdb.monitor(
          "console " + args.expression.substring(1).trim()
        );
        this.sendEvent(new OutputEvent(res, "console"));
        response.body = { result: "", variablesReference: 0 };
        return;
      }

      // Command help
      if (args.expression.match(/^h\s/i)) {
        const cmd = args.expression.replace(/^h\s+/, "");
        const help =
          commandHelp[cmd as keyof typeof commandHelp] ||
          `No help available for command '${cmd}'`;
        this.sendEvent(new OutputEvent(help, "console"));
        response.body = { result: "", variablesReference: 0 };
        return;
      }

      // Expression
      const body = await this.variableManager().evaluateExpression(args);
      if (body) {
        response.body = body;
        return;
      }

      // Default help summary
      response.body = { result: "", variablesReference: 0 };
      this.sendEvent(new OutputEvent(helpSummary, "console"));
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
      instructions.map(({ location }) => this.processSource(location));
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

  protected errorString(err: unknown): string {
    if (err instanceof Error)
      return this.trace ? err.stack || err.message : err.message;
    return String(err);
  }

  /**
   * Process a Source object before returning in to the client
   */
  protected processSource(source?: DebugProtocol.Source) {
    // Ensure path is in correct format for client
    if (source?.path) {
      source.path = this.convertDebuggerPathToClient(source.path);
    }
  }

  /**
   * Event handler for stop/halt event
   */
  protected async handleStop(e: HaltEvent) {
    logger.log(`[STOP] ${e.label} thread: ${e.threadId}`);

    // Any other halt code other than TRAP must be an exception:
    if (e.signal !== HaltSignal.TRAP) {
      logger.log(`[STOP] Exception`);
      this.sendStoppedEvent(Threads.CPU, "exception");
      return;
    }

    // Get stack position to find current PC address for thread
    const threadId = e.threadId ?? Threads.CPU;
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
        this.sendStoppedEvent(Threads.CPU, "step");
      } else {
        logger.log(`[STOP] ignoring while waiting for temporary breakpoint`);
        await this.gdb.continueExecution(Threads.CPU);
      }
      return;
    }

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
      this.sendStoppedEvent(threadId, "breakpoint");
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

  // Implementation specific overrides:
  // VS Code extension will override these methods to add native behaviours.

  protected getSourceConstantResolver(
    args: LaunchRequestArguments
  ): SourceConstantResolver {
    return new VasmSourceConstantResolver(args.vasm);
  }

  protected async onCpuFrame(_address: number): Promise<void> {
    // This will trigger an update to the disassembly view
  }

  protected async getDataBreakpointSize(_displayValue: string, _name: string) {
    // This will prompt for user input in VS Code
    // TODO: could have a better guess at size by looking at disassembly e.g. `dc.l` or address of next label
    return 2;
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
