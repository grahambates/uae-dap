import {
  InitializedEvent,
  TerminatedEvent,
  BreakpointEvent,
  Thread,
  StackFrame,
  Scope,
  Source,
  Handles,
  DebugSession,
  OutputEvent,
  ContinuedEvent,
  InvalidatedEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { URI as Uri } from "vscode-uri";
import { basename } from "path";
import { GdbProxy } from "./gdbProxy";
import { Segment, GdbHaltStatus } from "./gdbProxyCore";
import { ExecutorHelper } from "./execHelper";
import { DebugInfo } from "./debugInfo";
import { Capstone } from "./capstone";
import { DebugVariableResolver } from "./debugVariableResolver";
import {
  DebugExpressionHelper,
  DisassembledInstructionAdapter,
} from "./debugExpressionHelper";
import {
  DebugDisassembledManager,
  DisassembleAddressArguments,
} from "./debugDisassembled";
import { StringUtils } from "./stringUtils";
import { MemoryLabelsRegistry } from "./customMemoryAddresses";
import { BreakpointManager, GdbBreakpoint } from "./breakpointManager";
import { CopperDisassembler } from "./copperDisassembler";
import { FileProxy } from "./fsProxy";
import {
  VariableDisplayFormat,
  VariableDisplayFormatRequest,
  VariableFormatter,
} from "./variableFormatter";

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
export interface LaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments {
  /** An absolute path to the "program" to debug. */
  program: string;
  /** Automatically stop target after launch. If not specified, target does not stop. */
  stopOnEntry?: boolean;
  /** enable logging the Debug Adapter Protocol */
  trace?: boolean;
  /** Name of the server */
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
  emulatorOptions: Array<string>;
  /** cstool program */
  cstool?: string;
  /** path replacements for source files */
  // eslint-disable-next-line @typescript-eslint/ban-types
  sourceFileMap?: Object;
  /** root paths for sources */
  rootSourceFileMap?: Array<string>;
  /** default exception's mask */
  exceptionMask?: number;
  /** Waiting time for emulator start */
  emulatorStartDelay?: number;
}

export class FsUAEDebugSession
  extends DebugSession
  implements DebugVariableResolver
{
  /** prefix for register variables */
  public static readonly PREFIX_REGISTERS = "registers_";
  /** prefix for segments variables */
  public static readonly PREFIX_SEGMENTS = "segments_";
  /** prefix for symbols variables */
  public static readonly PREFIX_SYMBOLS = "symbols_";

  /** Timeout of the mutex */
  protected static readonly MUTEX_TIMEOUT = 100000;

  /** breakpoint event handler set */
  protected static BREAKPOINT_EVENT_SET = false;

  /** a Mock runtime (or debugger) */
  protected variableHandles = new Handles<string>();

  /** Proxy to Gdb */
  protected gdbProxy: GdbProxy;

  /** Variables references map */
  protected variableRefMap = new Map<number, DebugProtocol.Variable[]>();

  /** Variables expression map */
  protected variableExpressionMap = new Map<string, number>();

  /** Variables format map */
  protected variableFormatterMap = new Map<string, VariableFormatter | null>();

  /** All the symbols in the file */
  protected symbolsMap = new Map<string, number>();

  /** Test mode activated */
  protected testMode = false;

  /** Executor to run fs-uae */
  protected executor: ExecutorHelper;

  /** Token to cancel the emulator */
  // protected cancellationTokenSource?: CancellationTokenSource;

  /** Debug information for the loaded program */
  protected debugInfo?: DebugInfo;

  /** Tool to disassemble */
  protected capstone?: Capstone;

  /** Cache for disassembled code */
  protected disassembledCache = new Map<number, string>();

  /** Cache for disassembled code */
  protected disassembledCopperCache = new Map<number, string>();

  /** Helper class to deal with the debug expressions */
  protected debugExpressionHelper = new DebugExpressionHelper();

  /** Manager of disassembled code */
  protected debugDisassembledManager: DebugDisassembledManager;

  /** Breakpoint manager */
  protected breakpointManager: BreakpointManager;

  /** Current memory display pc */
  protected currentMemoryViewPc = -1;

  /** trace the communication protocol */
  protected trace = false;

  /**
   * Creates a new debug adapter that is used for one debug session.
   * We configure the default implementation of a debug adapter here.
   */
  public constructor() {
    super();
    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this.gdbProxy = this.createGdbProxy();
    this.gdbProxy.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
    this.initProxy();
    this.executor = new ExecutorHelper();
    this.debugDisassembledManager = new DebugDisassembledManager(
      this.gdbProxy,
      undefined,
      this
    );
    this.breakpointManager = new BreakpointManager(
      this.gdbProxy,
      this.debugDisassembledManager
    );
    this.breakpointManager.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
    // event handler to clean data breakpoints
    if (!FsUAEDebugSession.BREAKPOINT_EVENT_SET) {
      // vscode.debug.onDidChangeBreakpoints(BreakpointManager.onDidChangeBreakpoints);
      FsUAEDebugSession.BREAKPOINT_EVENT_SET = true;
    }
  }

  /**
   * Create a proxy
   */
  protected createGdbProxy(): GdbProxy {
    return new GdbProxy(undefined);
  }

  /**
   * Setting the context to run the tests.
   * @param gdbProxy mocked proxy
   * @param executor mocked executor
   * @param capstone mocked capstone
   */
  public setTestContext(
    gdbProxy: GdbProxy,
    executor: ExecutorHelper,
    capstone: Capstone
  ): void {
    this.executor = executor;
    this.gdbProxy = gdbProxy;
    this.gdbProxy.setMutexTimeout(1000);
    this.initProxy();
    this.testMode = true;
    this.capstone = capstone;
    this.debugDisassembledManager = new DebugDisassembledManager(
      gdbProxy,
      capstone,
      this
    );
    this.breakpointManager = new BreakpointManager(
      this.gdbProxy,
      this.debugDisassembledManager
    );
    this.breakpointManager.setMutexTimeout(1000);
  }

  /**
   * Returns the breakpoint manager (for tests)
   * @return the breakpoint manager
   */
  public getBreakpointManager(): BreakpointManager {
    return this.breakpointManager;
  }

  /**
   * Creates a stop event
   */
  protected crateStoppedEvent(
    threadId: number,
    reason: string,
    preserveFocusHint?: boolean
  ): DebugProtocol.StoppedEvent {
    return <DebugProtocol.StoppedEvent>{
      event: "stopped",
      body: {
        reason: reason,
        threadId: threadId,
        preserveFocusHint: preserveFocusHint,
        allThreadsStopped: true,
      },
    };
  }

  /**
   * Initialize proxy
   */
  public initProxy(): void {
    // setup event handlers
    this.gdbProxy.on("stopOnEntry", (threadId: number) => {
      this.sendEvent(this.crateStoppedEvent(threadId, "entry", false));
    });
    this.gdbProxy.on(
      "stopOnStep",
      (threadId: number, preserveFocusHint?: boolean) => {
        this.sendEvent(
          this.crateStoppedEvent(threadId, "step", preserveFocusHint)
        );
      }
    );
    this.gdbProxy.on("stopOnPause", (threadId: number) => {
      this.sendEvent(this.crateStoppedEvent(threadId, "pause", false));
    });
    this.gdbProxy.on("stopOnBreakpoint", (threadId: number) => {
      this.sendEvent(this.crateStoppedEvent(threadId, "breakpoint", false));
    });
    this.gdbProxy.on(
      "stopOnException",
      (_: GdbHaltStatus, threadId: number) => {
        this.sendEvent(this.crateStoppedEvent(threadId, "exception", false));
      }
    );
    this.gdbProxy.on(
      "continueThread",
      (threadId: number, allThreadsContinued?: boolean) => {
        this.sendEvent(new ContinuedEvent(threadId, allThreadsContinued));
      }
    );
    this.gdbProxy.on("segmentsUpdated", (segments: Array<Segment>) => {
      this.updateSegments(segments);
    });
    this.gdbProxy.on("breakpointValidated", (bp: GdbBreakpoint) => {
      // Dirty workaround to issue https://github.com/microsoft/vscode/issues/65993
      setTimeout(async () => {
        try {
          this.sendEvent(new BreakpointEvent("changed", bp));
        } catch (error) {
          // forget it
        }
      }, 100);
    });
    this.gdbProxy.on("threadStarted", (threadId: number) => {
      const event = <DebugProtocol.ThreadEvent>{
        event: "thread",
        body: {
          reason: "started",
          threadId: threadId,
        },
      };
      this.sendEvent(event);
    });
    this.gdbProxy.on(
      "output",
      (text: string, filePath?: string, line?: number, column?: number) => {
        if (this.trace) {
          const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
          if (filePath !== undefined) {
            e.body.source = this.createSource(filePath);
          }
          if (line !== undefined) {
            e.body.line = this.convertDebuggerLineToClient(line);
          }
          if (column !== undefined) {
            e.body.column = this.convertDebuggerColumnToClient(column);
          }
          this.sendEvent(e);
        }
      }
    );
    this.gdbProxy.on("end", () => {
      this.terminate();
    });
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse
  ): void {
    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};

    // the adapter implements the configurationDoneRequest.
    response.body.supportsConfigurationDoneRequest = false;

    // make VS Code to use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = true;

    // make VS Code to show a 'step back' button
    response.body.supportsStepBack = false;

    // Restart frame not supported
    response.body.supportsRestartFrame = false;

    // Conditional breakpoints not supported
    response.body.supportsConditionalBreakpoints = false;

    // Read memory
    response.body.supportsReadMemoryRequest = true;

    // make VS Code send disassemble request
    response.body.supportsDisassembleRequest = true;
    response.body.supportsSteppingGranularity = false;
    response.body.supportsInstructionBreakpoints = true;

    // Data breakpoint
    response.body.supportsDataBreakpoints = true;

    // Memory edition
    response.body.supportsWriteMemoryRequest = true;

    // value formatting option
    response.body.supportsValueFormattingOptions = true;

    // Set expression is accepted - TODO : Try it later
    //response.body.supportsSetExpression = true;

    response.body.supportsExceptionInfoRequest = true;
    response.body.supportsExceptionOptions = true;
    response.body.exceptionBreakpointFilters = [
      {
        filter: "all",
        label: "All Exceptions",
        default: true,
      },
    ];

    // This default debug adapter does support the 'setVariable' request.
    response.body.supportsSetVariable = true;

    this.sendResponse(response);

    // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
    // we request them early by sending an 'initializeRequest' to the frontend.
    // The frontend will end the configuration sequence by calling 'configurationDone' request.
    this.sendEvent(new InitializedEvent());
  }

  /**
   * Load the program with all the debug information
   */
  protected loadDebugInfo(args: LaunchRequestArguments): Promise<boolean> {
    const sMap = new Map<string, string>();
    if (args.sourceFileMap) {
      const keys = Object.keys(args.sourceFileMap);
      for (const k of keys) {
        const desc = Object.getOwnPropertyDescriptor(args.sourceFileMap, k);
        if (desc) {
          sMap.set(k, desc.value);
        }
      }
    }
    this.debugInfo = new DebugInfo(
      Uri.file(args.program),
      sMap,
      args.rootSourceFileMap
    );
    return this.debugInfo.load();
  }

  /**
   * Send a response containing an error.
   * @param response response to send
   * @param message Error message
   */
  protected sendStringErrorResponse(
    response: DebugProtocol.Response,
    message: string
  ): void {
    response.success = false;
    response.message = message;
    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    if (args.trace) {
      this.trace = args.trace;
    } else {
      this.trace = false;
    }
    // Does the program exists ? -> Loads the debug info
    let dInfoLoaded = false;
    try {
      if (args.exceptionMask) {
        this.breakpointManager.setExceptionMask(args.exceptionMask);
      }
      dInfoLoaded = await this.loadDebugInfo(args);
      if (dInfoLoaded && this.debugInfo) {
        this.breakpointManager.setDebugInfo(this.debugInfo);
        this.breakpointManager.checkPendingBreakpointsAddresses();
      }
      if (!args.program || !dInfoLoaded) {
        this.sendStringErrorResponse(
          response,
          "Invalid program to debug - review launch settings: " +
            JSON.stringify(dInfoLoaded) +
            " " +
            JSON.stringify(args)
        );
      } else {
        // Showing the help text
        if (!this.testMode) {
          const text =
            "Commands:\n" +
            "    Memory dump:\n" +
            "        m address, size[, wordSizeInBytes, rowSizeInWords,ab]\n" +
            "        			a: show ascii output, b: show bytes output\n" +
            "            example: m $5c50,10,2,4\n" +
            "        m ${register|symbol}, #{symbol}, size[, wordSizeInBytes, rowSizeInWords]\n" +
            "            example: m ${mycopperlabel},10,2,4\n" +
            "    Disassembled Memory dump:\n" +
            "        m address|${register|symbol}|#{symbol},size,d\n" +
            "            example: m ${pc},10,d\n" +
            "    Memory set:\n" +
            "        M address=bytes\n" +
            "            example: M $5c50=0ff534\n" +
            "        M ${register|symbol}=bytes\n" +
            "        M #{register|symbol}=bytes\n" +
            "            example: M ${mycopperlabel}=0ff534\n" +
            "      ${symbol} gives the address of symbol," +
            "      #{symbol} gives the pointed value from the symbol\n";
          this.sendEvent(new OutputEvent(text));
        }

        // Configure capstone
        if (!this.capstone && args.cstool && args.cstool.length > 5) {
          this.capstone = new Capstone(args.cstool);
          this.debugDisassembledManager.setCapstone(this.capstone);
        }

        // Launch the emulator
        try {
          this.startEmulator(args);
          let startDelay: number;
          if (args.emulatorStartDelay) {
            startDelay = args.emulatorStartDelay;
          } else {
            startDelay = 1500;
          }
          await new Promise<void>((resolve) => {
            setTimeout(async () => {
              await this.connect(response, args);
              resolve();
            }, startDelay);
          });
        } catch (err) {
          this.sendEvent(new TerminatedEvent());
          this.sendStringErrorResponse(response, (err as Error).message);
        }
      }
    } catch (err) {
      this.sendStringErrorResponse(
        response,
        "Invalid program to debug: " + (err as Error).message
      );
    }
  }

  protected connect(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    return new Promise((resolve) => {
      let timeoutValue = 3000;
      if (this.testMode) {
        timeoutValue = 1;
      }
      setTimeout(async () => {
        // connects to FS-UAE
        try {
          await this.gdbProxy.connect(args.serverName, args.serverPort);
          // Loads the program
          this.sendEvent(new OutputEvent(`Starting program: ${args.program}`));
          await this.gdbProxy.load(args.program, args.stopOnEntry);
          this.sendResponse(response);
        } catch (err) {
          this.sendStringErrorResponse(response, (err as Error).message);
        }
        resolve();
      }, timeoutValue);
    });
  }

  public checkEmulator(emulatorPath: string): Promise<boolean> {
    // Function useful for testing - mocking
    const fileProxy = new FileProxy(Uri.file(emulatorPath));
    return fileProxy.exists();
  }

  public async startEmulator(args: LaunchRequestArguments): Promise<void> {
    if (args.startEmulator) {
      this.sendEvent(new OutputEvent(`Starting emulator: ${args.emulator}`));
      if (args.emulator) {
        const emulatorExe = args.emulator;
        // Is the emulator exe present in the filesystem ?
        if (await this.checkEmulator(emulatorExe)) {
          // this.cancellationTokenSource = new CancellationTokenSource();
          const emulatorWorkingDir = args.emulatorWorkingDir || null;
          this.executor
            .runTool(
              args.emulatorOptions,
              emulatorWorkingDir,
              "warning",
              true,
              emulatorExe,
              null,
              true,
              null
              // this.cancellationTokenSource.token
            )
            .then(() => {
              this.sendEvent(new TerminatedEvent());
            })
            .catch((err) => {
              this.sendEvent(new TerminatedEvent());
              throw new Error(
                `Error raised by the emulator run: ${(err as Error).message}`
              );
            });
        } else {
          throw new Error(
            `The emulator executable '${emulatorExe}' cannot be found`
          );
        }
      } else {
        throw new Error(
          "The emulator executable file path must be defined in the launch settings"
        );
      }
    } else {
      this.sendEvent(new OutputEvent("Emulator starting skipped by settings"));
    }
  }

  protected customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: any
  ): void {
    if (command === "disassembleInner") {
      this.disassembleRequestInner(response, args);
    } else if (command === "modifyVariableFormat") {
      const variableReq: VariableDisplayFormatRequest = args;
      switch (variableReq.variableDisplayFormat) {
        case VariableDisplayFormat.BINARY:
          this.variableFormatterMap.set(
            variableReq.variableInfo.variable.name,
            VariableFormatter.BINARY_FORMATTER
          );
          break;
        case VariableDisplayFormat.HEXADECIMAL:
          this.variableFormatterMap.set(
            variableReq.variableInfo.variable.name,
            VariableFormatter.HEXADECIMAL_FORMATTER
          );
          break;
        case VariableDisplayFormat.DECIMAL:
          this.variableFormatterMap.set(
            variableReq.variableInfo.variable.name,
            VariableFormatter.DECIMAL_FORMATTER
          );
          break;
        default:
          this.variableFormatterMap.set(
            variableReq.variableInfo.variable.name,
            null
          );
          break;
      }
      this.sendEvent(new InvalidatedEvent(["variables"]));
      this.sendResponse(response);
    } else {
      super.customRequest(command, response, args);
    }
  }

  protected async disassembleRequestInner(
    response: DebugProtocol.DisassembleResponse,
    args: DisassembleAddressArguments
  ): Promise<void> {
    const newArgs = { ...args };
    try {
      let firstAddress = undefined;
      if (args.addressExpression && (args.offset || args.instructionOffset)) {
        const segments = this.gdbProxy.getSegments();
        if (segments) {
          firstAddress = parseInt(args.addressExpression);
          if (args.offset) {
            firstAddress = firstAddress - args.offset;
          }
          const segment = this.findSegmentForAddress(firstAddress, segments);
          if (segment) {
            newArgs.addressExpression = segment.address.toString();
          }
        }
      }
      let instructions = await this.debugDisassembledManager.disassembleRequest(
        newArgs
      );
      if (firstAddress) {
        let iIndex = undefined;
        let index = 0;
        const firstInstructionAddress = parseInt(instructions[0].address);
        for (const instruction of instructions) {
          if (parseInt(instruction.address) === firstAddress) {
            iIndex = index;
            break;
          }
          index++;
        }
        if (iIndex !== undefined && args.instructionOffset) {
          const start = iIndex + args.instructionOffset;
          if (start < 0) {
            const emptyArray = new Array<DebugProtocol.DisassembledInstruction>(
              -start
            );
            let currentAddress = firstInstructionAddress - 4;
            for (let i = emptyArray.length - 1; i >= 0; i--) {
              emptyArray[i] = <DebugProtocol.DisassembledInstruction>{
                address:
                  DisassembledInstructionAdapter.getAddressString(
                    currentAddress
                  ),
                instruction: "-------",
              };
              currentAddress -= 4;
              if (currentAddress < 0) {
                currentAddress = 0;
              }
            }
            instructions = emptyArray.concat(instructions);
          } else if (start > 0 && start < instructions.length) {
            instructions = instructions.splice(0, start);
          }
          if (instructions.length < args.instructionCount) {
            const emptyArray = new Array<DebugProtocol.DisassembledInstruction>(
              args.instructionCount - instructions.length
            );
            const instr = instructions[instructions.length - 1];
            let lastAddress = parseInt(instr.address);
            if (instr.instructionBytes) {
              lastAddress += instr.instructionBytes.split(" ").length;
            }
            for (let i = 0; i < emptyArray.length; i++) {
              emptyArray[i] = <DebugProtocol.DisassembledInstruction>{
                address: DisassembledInstructionAdapter.getAddressString(
                  lastAddress + i * 4
                ),
                instruction: "-------",
              };
            }
            instructions = instructions.concat(emptyArray);
          } else if (instructions.length > args.instructionCount) {
            instructions = instructions.splice(0, args.instructionCount);
          }
        }
      }
      await this.findInstructionSourceLines(instructions);
      response.body = {
        instructions: instructions,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments
  ): Promise<void> {
    const isCopper =
      this.disassembledCopperCache.get(parseInt(args.memoryReference)) !==
      undefined;
    const dArgs = DisassembleAddressArguments.copy(args, isCopper);
    return this.disassembleRequestInner(response, dArgs);
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments
  ) {
    const debugBreakPoints = new Array<DebugProtocol.Breakpoint>();
    // clear all breakpoints for this file
    await this.breakpointManager.clearInstructionBreakpoints();
    // set and verify breakpoint locations
    if (args.breakpoints) {
      for (const reqBp of args.breakpoints) {
        const debugBp = this.breakpointManager.createInstructionBreakpoint(
          parseInt(reqBp.instructionReference)
        );
        try {
          const modifiedBp = await this.breakpointManager.setBreakpoint(
            debugBp
          );
          debugBreakPoints.push(modifiedBp);
        } catch (err) {
          debugBreakPoints.push(debugBp);
        }
      }
    }
    // send back the actual breakpoint positions
    response.body = {
      breakpoints: debugBreakPoints,
    };
    response.success = true;
    this.sendResponse(response);
  }

  protected terminateEmulator(): void {
    // if (this.cancellationTokenSource) {
    //   this.cancellationTokenSource.cancel();
    // }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    const debugBreakPoints = new Array<DebugProtocol.Breakpoint>();
    // clear all breakpoints for this file
    await this.breakpointManager.clearBreakpoints(args.source);
    // set and verify breakpoint locations
    if (args.breakpoints) {
      for (const reqBp of args.breakpoints) {
        const debugBp = this.breakpointManager.createBreakpoint(
          args.source,
          reqBp.line
        );
        try {
          const modifiedBp = await this.breakpointManager.setBreakpoint(
            debugBp
          );
          debugBreakPoints.push(modifiedBp);
        } catch (err) {
          debugBreakPoints.push(debugBp);
        }
      }
    }
    // send back the actual breakpoint positions
    response.body = {
      breakpoints: debugBreakPoints,
    };
    response.success = true;
    this.sendResponse(response);
  }

  protected async threadsRequest(
    response: DebugProtocol.ThreadsResponse
  ): Promise<void> {
    try {
      await this.gdbProxy.waitConnected();
      const thIds = await this.gdbProxy.getThreadIds();
      const threads = new Array<Thread>();
      for (const t of thIds) {
        threads.push(
          new Thread(t.getId(), this.gdbProxy.getThreadDisplayName(t))
        );
      }
      response.body = {
        threads: threads,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }
  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): Promise<void> {
    if (this.debugInfo) {
      await this.gdbProxy.waitConnected();
      const dbgInfo = this.debugInfo;
      const thread = this.gdbProxy.getThread(args.threadId);
      if (thread) {
        try {
          const stk = await this.gdbProxy.stack(thread);
          const stackFrames = [];
          let updatedView = false;
          for (const f of stk.frames) {
            if (!updatedView && this.gdbProxy.isCPUThread(thread)) {
              // Update the cpu view
              // this.updateDisassembledView(f.pc, 100);
              this.updateDisassembledView(f.pc);
              updatedView = true;
              // check temporary breakpoints
              this.breakpointManager.checkTemporaryBreakpoints(f.pc);
            }
            let stackFrameDone = false;
            const pc = VariableFormatter.ADDRESS_FORMATTER.format(f.pc);
            if (f.segmentId >= 0) {
              const values = await dbgInfo.resolveFileLine(
                f.segmentId,
                f.offset
              );
              if (values) {
                let line = values[2];
                if (line) {
                  const idx = line.indexOf(";");
                  if (idx > 0) {
                    line = line.substring(0, idx);
                  }
                  line = pc + ": " + line.trim().replace(/\s\s+/g, " ");
                } else {
                  line = pc;
                }
                const sf = new StackFrame(
                  f.index,
                  line,
                  this.createSource(values[0]),
                  values[1],
                  1
                );
                sf.instructionPointerReference = StringUtils.formatAddress(
                  f.pc
                );
                stackFrames.push(sf);
                stackFrameDone = true;
              }
            }
            if (!stackFrameDone) {
              let line: string = pc;
              if (this.gdbProxy.isCPUThread(thread)) {
                const dCode = this.disassembledCache.get(f.pc);
                if (dCode) {
                  line = dCode;
                } else {
                  // Get the disassembled line
                  line += ": ";
                  if (this.capstone) {
                    try {
                      const memory = await this.gdbProxy.getMemory(f.pc, 10);
                      const disassembled = await this.capstone.disassemble(
                        memory
                      );
                      const lines = disassembled.split(/\r\n|\r|\n/g);
                      let selectedLine = lines[0];
                      for (const l of lines) {
                        if (l.trim().length > 0) {
                          selectedLine = l;
                          break;
                        }
                      }
                      const elms = selectedLine.split("  ");
                      if (elms.length > 2) {
                        selectedLine = elms[2];
                      }
                      line += selectedLine.trim().replace(/\s\s+/g, " ");
                    } catch (err) {
                      console.error("Error ignored: " + (err as Error).message);
                    }
                  }
                  this.disassembledCache.set(f.pc, line);
                }
              } else if (this.gdbProxy.isCopperThread(thread)) {
                const dCopperCode = this.disassembledCopperCache.get(f.pc);
                if (dCopperCode) {
                  line = dCopperCode;
                } else {
                  // Get the disassembled line
                  line += ": ";
                  try {
                    const memory = await this.gdbProxy.getMemory(f.pc, 10);
                    const cDis = new CopperDisassembler(memory);
                    line =
                      line + cDis.disassemble()[0].toString().split("    ")[0];
                    this.disassembledCopperCache.set(f.pc, line);
                  } catch (err) {
                    console.error("Error ignored: " + (err as Error).message);
                  }
                }
              }
              // The the stack frame from the manager
              const stackFrame =
                await this.debugDisassembledManager.getStackFrame(
                  f.index,
                  f.pc,
                  line,
                  this.gdbProxy.isCopperThread(thread)
                );
              stackFrames.push(stackFrame);
            }
          }
          response.body = {
            stackFrames: stackFrames,
            totalFrames: stk.count,
          };
          this.sendResponse(response);
        } catch (err) {
          this.sendStringErrorResponse(response, (err as Error).message);
        }
      } else {
        this.sendStringErrorResponse(response, "Unknown thread");
      }
    } else {
      this.sendStringErrorResponse(response, "No debug info loaded");
    }
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    const frameReference = args.frameId;
    const scopes = new Array<Scope>();
    scopes.push(<DebugProtocol.Scope>{
      name: "Registers",
      variablesReference: this.variableHandles.create(
        FsUAEDebugSession.PREFIX_REGISTERS + frameReference
      ),
      presentationHint: "registers",
      expensive: false,
    });
    scopes.push(
      new Scope(
        "Segments",
        this.variableHandles.create(
          FsUAEDebugSession.PREFIX_SEGMENTS + frameReference
        ),
        true
      )
    );
    scopes.push(
      new Scope(
        "Symbols",
        this.variableHandles.create(
          FsUAEDebugSession.PREFIX_SYMBOLS + frameReference
        ),
        true
      )
    );

    response.body = {
      scopes: scopes,
    };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    const variables = this.variableRefMap.get(args.variablesReference);
    if (variables) {
      response.body = {
        variables: variables,
      };
      this.sendResponse(response);
    } else {
      const id = this.variableHandles.get(args.variablesReference);
      await this.gdbProxy.waitConnected();
      if (id !== null) {
        if (id.startsWith(FsUAEDebugSession.PREFIX_REGISTERS)) {
          try {
            //Gets the frameId
            const frameId = parseInt(id.substring(10));
            const registers = await this.gdbProxy.registers(frameId, null);
            const variablesArray = new Array<DebugProtocol.Variable>();
            const srVariablesArray = new Array<DebugProtocol.Variable>();
            const srVRef = this.variableHandles.create(
              "status_register_" + frameId
            );
            for (const r of registers) {
              let variableName = r.name;
              if (r.name.startsWith("SR_")) {
                variableName = variableName.replace("SR_", "");
                let formatter = this.variableFormatterMap.get(variableName);
                if (!formatter) {
                  formatter = VariableFormatter.DECIMAL_FORMATTER;
                }
                srVariablesArray.push({
                  name: variableName,
                  type: "register",
                  value: formatter.format(r.value),
                  variablesReference: 0,
                });
              } else {
                let vRef = 0;
                if (r.name.startsWith("sr")) {
                  vRef = srVRef;
                }
                let formatter = this.variableFormatterMap.get(variableName);
                if (!formatter) {
                  formatter = VariableFormatter.HEXADECIMAL_FORMATTER;
                }
                variablesArray.push({
                  name: variableName,
                  type: "register",
                  value: formatter.format(r.value),
                  variablesReference: vRef,
                  memoryReference: r.value.toString(),
                });
              }
            }
            this.variableRefMap.set(srVRef, srVariablesArray);
            response.body = {
              variables: variablesArray,
            };
            this.sendResponse(response);
          } catch (err) {
            this.sendStringErrorResponse(response, (err as Error).message);
          }
        } else if (id.startsWith(FsUAEDebugSession.PREFIX_SEGMENTS)) {
          const variablesArray = new Array<DebugProtocol.Variable>();
          const segments = this.gdbProxy.getSegments();
          if (segments) {
            for (let i = 0; i < segments.length; i++) {
              const s = segments[i];
              const variableName = `Segment #${i}`;
              let formatter = this.variableFormatterMap.get(variableName);
              if (!formatter) {
                formatter = VariableFormatter.HEXADECIMAL_FORMATTER;
              }
              variablesArray.push({
                name: variableName,
                type: "segment",
                value: `${formatter.format(s.address)} {size:${s.size}}`,
                variablesReference: 0,
                memoryReference: s.address.toString(),
              });
            }
            response.body = {
              variables: variablesArray,
            };
          } else {
            response.success = false;
            response.message = "No Segments found";
          }
          this.sendResponse(response);
        } else if (id.startsWith(FsUAEDebugSession.PREFIX_SYMBOLS)) {
          const variablesArray = new Array<DebugProtocol.Variable>();
          const symbolsList = Array.from(this.symbolsMap.entries()).sort(
            StringUtils.compareStringsLowerCase
          );
          for (const entry of symbolsList) {
            const key = entry[0];
            const value = entry[1];
            const variableName = key;
            let formatter = this.variableFormatterMap.get(variableName);
            if (!formatter) {
              formatter = VariableFormatter.HEXADECIMAL_FORMATTER;
            }
            variablesArray.push({
              name: key,
              type: "symbol",
              value: formatter.format(value),
              variablesReference: 0,
              memoryReference: value.toString(),
            });
          }
          response.body = {
            variables: variablesArray,
          };
          this.sendResponse(response);
        } else {
          this.sendStringErrorResponse(response, "Unknown variable");
        }
      } else {
        this.sendStringErrorResponse(response, "No id to variable");
      }
    }
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments
  ): Promise<void> {
    const id = this.variableHandles.get(args.variablesReference);
    if (id !== null && id.startsWith(FsUAEDebugSession.PREFIX_REGISTERS)) {
      try {
        const newValue = await this.gdbProxy.setRegister(args.name, args.value);
        response.body = {
          value: newValue,
        };
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "This variable cannot be set");
    }
  }

  public terminate(): void {
    this.gdbProxy.destroy();
    this.terminateEmulator();
  }

  public shutdown(): void {
    this.terminate();
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (thread) {
      try {
        await this.gdbProxy.continueExecution(thread);
        response.body = {
          allThreadsContinued: false,
        };
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "Unknown thread");
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (thread) {
      try {
        await this.gdbProxy.stepToRange(thread, 0, 0);
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "Unknown thread");
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (thread) {
      try {
        await this.gdbProxy.stepIn(thread);
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
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (thread) {
      try {
        const stk = await this.gdbProxy.stack(thread);
        const frame = stk.frames[1];
        const startAddress = frame.pc + 1;
        const endAddress = frame.pc + 10;
        await this.gdbProxy.stepToRange(thread, startAddress, endAddress);
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "Unknown thread");
    }
  }

  protected async evaluateRequestRegister(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    // It's a reg value
    try {
      await this.gdbProxy.waitConnected();
      const value = await this.gdbProxy.getRegister(
        args.expression,
        args.frameId
      );
      const valueNumber = parseInt(value[0], 16);
      let formatter = this.variableFormatterMap.get(args.expression);
      if (!formatter) {
        formatter = VariableFormatter.HEXADECIMAL_FORMATTER;
      }
      const strValue = formatter.format(valueNumber);
      response.body = {
        result: strValue,
        variablesReference: 0,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments
  ): Promise<void> {
    const address = parseInt(args.memoryReference);
    try {
      await this.gdbProxy.waitConnected();
      let size = 0;
      let memory = "";
      const DEFAULT_CHUNK_SIZE = 1000;
      let remaining = args.count;
      while (remaining > 0) {
        let chunkSize = DEFAULT_CHUNK_SIZE;
        if (remaining < chunkSize) {
          chunkSize = remaining;
        }
        memory += await this.gdbProxy.getMemory(address + size, chunkSize);
        remaining -= chunkSize;
        size += chunkSize;
      }
      let unreadable = args.count - size;
      if (unreadable < 0) {
        unreadable = 0;
      }
      response.body = {
        address: address.toString(16),
        data: StringUtils.hexToBase64(memory),
        //unreadableBytes: unreadable
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  public async getMemory(address: number, size: number): Promise<string> {
    await this.gdbProxy.waitConnected();
    return this.gdbProxy.getMemory(address, size);
  }

  protected async writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments
  ): Promise<void> {
    let address = parseInt(args.memoryReference);
    if (args.offset) {
      address += args.offset;
    }
    try {
      await this.gdbProxy.waitConnected();
      const hexString = StringUtils.base64ToHex(args.data);
      const count = hexString.length;
      const DEFAULT_CHUNK_SIZE = 1000;
      let remaining = count;
      let size = 0;
      while (remaining > 0) {
        let chunkSize = DEFAULT_CHUNK_SIZE;
        if (remaining < chunkSize) {
          chunkSize = remaining;
        }
        await this.gdbProxy.setMemory(
          address,
          hexString.substring(size, chunkSize)
        );
        remaining -= chunkSize;
        size += chunkSize;
      }
      response.body = {
        bytesWritten: size,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  public async getVariablePointedMemory(
    variableName: string,
    frameIndex?: number,
    size?: number
  ): Promise<string> {
    const address = await this.getVariableValueAsNumber(
      variableName,
      frameIndex
    );
    let lSize = size;
    if (lSize === undefined) {
      // By default me assume it is an address 32b
      lSize = 4;
    }
    // call to get the value in memory for this address
    await this.gdbProxy.waitConnected();
    return this.gdbProxy.getMemory(address, lSize);
  }

  public async getVariableValue(
    variableName: string,
    frameIndex?: number
  ): Promise<string> {
    const value = await this.getVariableValueAsNumber(variableName, frameIndex);
    let formatter = this.variableFormatterMap.get(variableName);
    if (!formatter) {
      formatter = VariableFormatter.HEXADECIMAL_FORMATTER;
    }
    return formatter.format(value);
  }

  public async getVariableValueAsNumber(
    variableName: string,
    frameIndex?: number
  ): Promise<number> {
    // Is it a register?
    const matches = /^([ad][0-7]|pc|sr)$/i.exec(variableName);
    if (matches) {
      await this.gdbProxy.waitConnected();
      const values = await this.gdbProxy.getRegister(variableName, frameIndex);
      return parseInt(values[0], 16);
    } else {
      // Is it a symbol?
      let address = this.symbolsMap.get(variableName);
      if (address !== undefined) {
        return address;
      } else {
        // Is it a standard register
        address = MemoryLabelsRegistry.getCustomAddress(
          variableName.toUpperCase()
        );
        if (address !== undefined) {
          return address;
        } else {
          throw new Error("Unknown symbol " + variableName);
        }
      }
    }
  }

  protected async evaluateRequestGetMemory(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    const matches =
      /m\s*([{}$#0-9a-z_+\-*/%()]+)\s*,\s*(\d+)(,\s*(\d+),\s*(\d+))?(,([abd]+))?/i.exec(
        args.expression
      );
    if (matches) {
      let rowLength = 4;
      let wordLength = 4;
      let mode = "ab";
      const length = parseInt(matches[2]);
      if (matches.length > 5 && matches[4] && matches[5]) {
        wordLength = parseInt(matches[4]);
        rowLength = parseInt(matches[5]);
      }
      if (matches.length > 7 && matches[7]) {
        mode = matches[7];
      }
      if (length !== null) {
        try {
          // replace the address if it is a variable
          const address =
            await this.debugExpressionHelper.getAddressFromExpression(
              matches[1],
              args.frameId,
              this
            );
          // ask for memory dump
          await this.gdbProxy.waitConnected();
          const memory = await this.gdbProxy.getMemory(address, length);
          let key = this.variableExpressionMap.get(args.expression);
          if (!key) {
            key = this.variableHandles.create(args.expression);
          }
          const startAddress = address;
          if (mode !== "d") {
            const [firstRow, variables] =
              this.debugExpressionHelper.processOutputFromMemoryDump(
                memory,
                startAddress,
                mode,
                wordLength,
                rowLength
              );
            this.variableRefMap.set(key, variables);
            this.variableExpressionMap.set(args.expression, key);
            response.body = {
              result: firstRow,
              type: "array",
              variablesReference: key,
            };
            this.sendResponse(response);
          } else {
            if (this.capstone) {
              const constKey = key;
              // disassemble the code
              const code = await this.capstone.disassemble(memory);
              const [firstRow, variables] =
                this.debugExpressionHelper.processVariablesFromDisassembler(
                  code,
                  startAddress
                );
              this.variableRefMap.set(constKey, variables);
              this.variableExpressionMap.set(args.expression, constKey);
              response.body = {
                result: firstRow,
                type: "array",
                variablesReference: constKey,
              };
              this.sendResponse(response);
            } else {
              this.sendStringErrorResponse(
                response,
                "Capstone cstool must be configured in the settings"
              );
            }
          }
        } catch (err) {
          this.sendStringErrorResponse(response, (err as Error).message);
        }
      } else {
        this.sendStringErrorResponse(
          response,
          "Invalid memory dump expression"
        );
      }
    } else {
      this.sendStringErrorResponse(response, "Expression not recognized");
    }
  }

  protected async evaluateRequestSetMemory(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    const matches = /M\s*([{}$#0-9a-z_]+)\s*=\s*([0-9a-z_]+)/i.exec(
      args.expression
    );
    if (matches) {
      const addrStr = matches[1];
      const data = matches[2];
      if (addrStr !== null && data !== null && data.length > 0) {
        try {
          // replace the address if it is a variable
          const address =
            await this.debugExpressionHelper.getAddressFromExpression(
              addrStr,
              args.frameId,
              this
            );
          await this.gdbProxy.waitConnected();
          await this.gdbProxy.setMemory(address, data);
          args.expression = "m" + addrStr + "," + data.length.toString(16);
          return this.evaluateRequestGetMemory(response, args);
        } catch (err) {
          this.sendStringErrorResponse(response, (err as Error).message);
        }
      } else {
        this.sendStringErrorResponse(response, "Invalid memory set expression");
      }
    } else {
      this.sendStringErrorResponse(response, "Expression not recognized");
    }
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    // Evaluate an expression
    const matches = /^([ad][0-7]|pc|sr)$/i.exec(args.expression);
    if (matches) {
      if (args.expression.startsWith("a") && args.context === "watch") {
        // let format = ConfigurationHelper.retrieveStringPropertyInDefaultConf(
        //   "display.memoryFormat.watch"
        // );
        // if (!format) {
        const format = "m ${symbol},100,2,4";
        // }
        args.expression = format.replace("symbol", args.expression);
        this.evaluateRequestGetMemory(response, args);
      } else {
        this.evaluateRequestRegister(response, args);
      }
    } else if (args.expression.startsWith("m")) {
      this.evaluateRequestGetMemory(response, args);
    } else if (args.expression.startsWith("M")) {
      this.evaluateRequestSetMemory(response, args);
    } else if (this.symbolsMap.has(args.expression)) {
      let format;
      if (args.context === "watch") {
        // format = ConfigurationHelper.retrieveStringPropertyInDefaultConf(
        //   "display.memoryFormat.watch"
        // );
        // if (!format) {
        format = "m ${symbol},104,2,4";
        // }
      } else {
        // format = ConfigurationHelper.retrieveStringPropertyInDefaultConf(
        //   "display.memoryFormat.hover"
        // );
        // if (!format) {
        format = "m ${symbol},24,2,4";
        // }
      }
      args.expression = format.replace("symbol", args.expression);
      this.evaluateRequestGetMemory(response, args);
    } else {
      try {
        const address =
          await this.debugExpressionHelper.getAddressFromExpression(
            args.expression,
            args.frameId,
            this
          );
        response.body = {
          result: VariableFormatter.HEXADECIMAL_FORMATTER.format(address),
          type: "string",
          variablesReference: 0,
        };
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    }
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (thread) {
      try {
        await this.gdbProxy.pause(thread);
        this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    } else {
      this.sendStringErrorResponse(response, "Unknown thread");
    }
  }

  protected async exceptionInfoRequest(
    response: DebugProtocol.ExceptionInfoResponse
  ): Promise<void> {
    try {
      await this.gdbProxy.waitConnected();
      const haltStatus = await this.gdbProxy.getHaltStatus();
      let selectedHs: GdbHaltStatus = haltStatus[0];
      for (const hs of haltStatus) {
        if (hs.thread && this.gdbProxy.isCPUThread(hs.thread)) {
          selectedHs = hs;
          break;
        }
      }
      response.body = {
        exceptionId: selectedHs.code.toString(),
        description: selectedHs.details,
        breakMode: "always",
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments
  ): Promise<void> {
    try {
      if (args.filters.length > 0) {
        await this.breakpointManager.setExceptionBreakpoint();
        response.success = true;
        this.sendResponse(response);
      } else {
        await this.breakpointManager.removeExceptionBreakpoint();
        response.success = true;
        this.sendResponse(response);
      }
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  /**
   * Updates the segments addresses of th hunks
   *
   *@param segments The list of returned segments from the debugger
   */
  public updateSegments(segments: Array<Segment>): void {
    if (this.debugInfo) {
      const lastPos = this.debugInfo.hunks.length;
      for (let posSegment = 0; posSegment < lastPos; posSegment++) {
        // Segments in order of file
        const hunk = this.debugInfo.hunks[posSegment];
        let segment;
        let address;
        if (posSegment >= segments.length) {
          // Segment not declared by the protocol
          segment = <Segment>{
            id: posSegment,
            address: 0,
            name: "",
            size: hunk.allocSize,
          };
          address = this.gdbProxy.addSegment(segment);
        } else {
          segment = segments[posSegment];
          address = segment.address;
          segment.size = hunk.allocSize;
        }
        hunk.segmentsId = posSegment;
        hunk.segmentsAddress = address;
        // Retrieve the symbols
        if (hunk.symbols) {
          for (const s of hunk.symbols) {
            this.symbolsMap.set(s.name, s.offset + address);
          }
        }
      }
    }
  }

  public async updateDisassembledView(
    address: number
    // length: number
  ): Promise<void> {
    if (address !== this.currentMemoryViewPc) {
      this.currentMemoryViewPc = address;
      // const dLines =
      //   await this.debugDisassembledManager.disassembleNumericalAddressCPU(
      //     address,
      //     length
      //   );
      // await vscode.commands.executeCommand(
      //   "disassembledMemory.setDisassembledMemory",
      //   dLines
      // );
    }
  }

  //---- helpers
  protected createSource(filePath: string): Source {
    return new Source(
      basename(filePath),
      this.convertDebuggerPathToClient(filePath)
    );
  }

  protected async findInstructionSourceLines(
    instructions: DebugProtocol.DisassembledInstruction[]
  ): Promise<void> {
    const segments = this.gdbProxy.getSegments();
    if (segments) {
      for (const instruction of instructions) {
        const values = await this.findSourceLine(
          parseInt(instruction.address),
          segments
        );
        if (values) {
          const [source, lineNumber] = values;
          instruction.location = source;
          instruction.line = lineNumber;
        }
      }
    }
  }

  protected async findSourceLine(
    address: number,
    segments: Segment[]
  ): Promise<[Source, number] | undefined> {
    if (this.debugInfo) {
      const selectedSegment = this.findSegmentForAddress(address, segments);
      if (selectedSegment) {
        const values = await this.debugInfo.resolveFileLine(
          selectedSegment.id,
          address - selectedSegment.address
        );
        if (values) {
          return [this.createSource(values[0]), values[1]];
        }
      }
    }
    return undefined;
  }

  protected findSegmentForAddress(
    address: number,
    segments: Segment[]
  ): Segment | undefined {
    for (const segment of segments) {
      if (this.isAddressInSegment(address, segment)) {
        return segment;
      }
    }
    return undefined;
  }

  protected isAddressInSegment(address: number, segment: Segment): boolean {
    return (
      address >= segment.address && address < segment.address + segment.size
    );
  }
}
