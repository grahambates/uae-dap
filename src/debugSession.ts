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
import promiseRetry from "promise-retry";

import { GdbProxy, GdbSegment, GdbHaltStatus, GdbBreakpoint } from "./gdb";
import { FileParser } from "./parsing/fileParser";
import { evaluateExpression } from "./expressions";
import { DisassemblyManager, DisassembleAddressArguments } from "./disassembly";
import { BreakpointManager } from "./breakpointManager";
import { processOutputFromMemoryDump, getCustomAddress } from "./memory";
import { disassemble, disassembleCopper } from "./disassembly";
import {
  base64ToHex,
  compareStringsLowerCase,
  formatAddress,
  formatHexadecimal,
  formatNumber,
  hexToBase64,
  NumberFormat,
} from "./strings";
import { Emulator } from "./emulator";

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
  emulatorOptions: string[];
  /** path replacements for source files */
  sourceFileMap?: Record<string, string>;
  /** root paths for sources */
  rootSourceFileMap?: string[];
  /** default exception's mask */
  exceptionMask?: number;
}

export interface VariableDisplayFormatRequest {
  /** info of the variable */
  variableInfo: any;
  /** Requested format */
  format: NumberFormat;
}

export class FsUAEDebugSession extends DebugSession {
  /** prefix for register variables */
  public static readonly PREFIX_REGISTERS = "registers_";
  /** prefix for segments variables */
  public static readonly PREFIX_SEGMENTS = "segments_";
  /** prefix for symbols variables */
  public static readonly PREFIX_SYMBOLS = "symbols_";

  /** Timeout of the mutex */
  protected static readonly MUTEX_TIMEOUT = 100000;

  /** Proxy to Gdb */
  protected gdbProxy: GdbProxy;
  /** Breakpoint manager */
  protected breakpointManager: BreakpointManager;
  /** Emulator instance */
  protected emulator: Emulator;

  /** Variable handles */
  protected variableHandles = new Handles<string>();
  /** Variables references map */
  protected variableRefMap = new Map<number, DebugProtocol.Variable[]>();
  /** Variables expression map */
  protected variableExpressionMap = new Map<string, number>();
  /** Variables format map */
  protected variableFormatterMap = new Map<string, NumberFormat>();
  /** All the symbols in the file */
  protected symbolsMap = new Map<string, number>();
  /** Test mode activated */
  protected testMode = false;
  /** Debug information for the loaded program */
  protected fileParser?: FileParser;
  /** Cache for disassembled code */
  protected disassembledCache = new Map<number, string>();
  /** Cache for disassembled code */
  protected disassembledCopperCache = new Map<number, string>();
  /** Manager of disassembled code */
  protected disassemblyManager: DisassemblyManager;
  /** Current memory display pc */
  protected currentMemoryViewPc = -1;
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

    this.gdbProxy = new GdbProxy();
    this.gdbProxy.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
    this.initProxy();

    this.disassemblyManager = new DisassemblyManager(this.gdbProxy, this);

    this.breakpointManager = new BreakpointManager(
      this.gdbProxy,
      this.disassemblyManager
    );

    this.emulator = new Emulator();
    this.breakpointManager.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
  }

  /**
   * Setting the context to run the tests.
   * @param gdbProxy mocked proxy
   */
  public setTestContext(gdbProxy: GdbProxy, emulator: Emulator): void {
    this.gdbProxy = gdbProxy;
    this.gdbProxy.setMutexTimeout(1000);
    this.initProxy();
    this.testMode = true;
    this.breakpointManager = new BreakpointManager(
      this.gdbProxy,
      this.disassemblyManager
    );
    this.breakpointManager.setMutexTimeout(1000);
    this.emulator = emulator;
  }

  /**
   * Returns the breakpoint manager (for tests)
   * @return the breakpoint manager
   */
  public getBreakpointManager(): BreakpointManager {
    return this.breakpointManager;
  }

  /**
   * Initialize proxy
   */
  public initProxy(): void {
    // setup event handlers
    this.gdbProxy.on("stopOnEntry", (threadId: number) => {
      this.sendStoppedEvent(threadId, "entry", false);
    });
    this.gdbProxy.on(
      "stopOnStep",
      (threadId: number, preserveFocusHint?: boolean) => {
        // Only send step events for stopped threads
        if (this.stoppedThreads[threadId]) {
          this.sendStoppedEvent(threadId, "step", preserveFocusHint);
        }
      }
    );
    this.gdbProxy.on("stopOnPause", (threadId: number) => {
      // Only send pause evens for running threads
      if (!this.stoppedThreads[threadId]) {
        this.sendStoppedEvent(threadId, "pause", false);
      }
    });
    this.gdbProxy.on("stopOnBreakpoint", (threadId: number) => {
      // Only send breakpoint evens for running threads
      if (!this.stoppedThreads[threadId]) {
        this.sendStoppedEvent(threadId, "breakpoint", false);
      }
    });
    this.gdbProxy.on(
      "stopOnException",
      (_: GdbHaltStatus, threadId: number) => {
        this.sendStoppedEvent(threadId, "exception", false);
      }
    );
    this.gdbProxy.on(
      "continueThread",
      (threadId: number, allThreadsContinued?: boolean) => {
        this.stoppedThreads[threadId] = false;
        this.sendEvent(new ContinuedEvent(threadId, allThreadsContinued));
      }
    );
    this.gdbProxy.on("segmentsUpdated", (segments: GdbSegment[]) => {
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

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    try {
      if (!args.program) {
        throw new Error("Missing program argument in launch request");
      }

      // Program is set - try to parse it:
      this.fileParser = new FileParser(
        Uri.file(args.program),
        args.sourceFileMap,
        args.rootSourceFileMap
      );
      if (!(await this.fileParser.parse())) {
        throw new Error("Unable to parse program " + args.program);
      }

      this.breakpointManager.setFileParser(this.fileParser);
      this.breakpointManager.checkPendingBreakpointsAddresses();

      if (args.exceptionMask) {
        this.breakpointManager.setExceptionMask(args.exceptionMask);
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
          onExit: () => this.terminate(),
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
        (retry) =>
          this.gdbProxy.connect(args.serverName, args.serverPort).catch(retry),
        { minTimeout: 500, retries, factor: 1.1 }
      );

      // Load the program
      this.sendEvent(new OutputEvent(`Starting program: ${args.program}`));
      await this.gdbProxy.load(args.program, args.stopOnEntry);

      this.sendResponse(response);
    } catch (err) {
      this.sendEvent(new TerminatedEvent());
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected sendHelpText() {
    const text = `Commands:
    Memory dump:
        m address, size[, wordSizeInBytes, rowSizeInWords,ab]
        			a: show ascii output, b: show bytes output
            example: m $5c50,10,2,4
        m \${register|symbol}, #{symbol}, size[, wordSizeInBytes, rowSizeInWords]
            example: m \${mycopperlabel},10,2,4
    Disassembled Memory dump:
        m address|\${register|symbol}|#{symbol},size,d
            example: m \${pc},10,d
    Memory set:
        M address=bytes
            example: M $5c50=0ff534
        M \${register|symbol}=bytes
        M #{register|symbol}=bytes
            example: M \${mycopperlabel}=0ff534
      \${symbol} gives the address of symbol
      #{symbol} gives the pointed value from the symbols
`;
    this.sendEvent(new OutputEvent(text));
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
      this.variableFormatterMap.set(
        variableReq.variableInfo.variable.name,
        variableReq.format
      );
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
      let instructions = await this.disassemblyManager.disassembleRequest(
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
              emptyArray[i] = {
                address: formatHexadecimal(currentAddress),
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
              emptyArray[i] = {
                address: formatHexadecimal(lastAddress + i * 4),
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
      const threadIds = await this.gdbProxy.getThreadIds();
      const threads = threadIds.map(
        (t) => new Thread(t.getId(), this.gdbProxy.getThreadDisplayName(t))
      );
      response.body = { threads };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): Promise<void> {
    if (!this.fileParser) {
      return this.sendStringErrorResponse(response, "No debug info loaded");
    }
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }

    try {
      const { frames, count: totalFrames } = await this.gdbProxy.stack(thread);
      const stackFrames = [];
      let updatedView = false;

      for (const f of frames) {
        if (!updatedView && this.gdbProxy.isCPUThread(thread)) {
          // Update the cpu view
          this.updateDisassembledView(f.pc);
          updatedView = true;
          this.breakpointManager.checkTemporaryBreakpoints(f.pc);
        }
        let stackFrameDone = false;
        const pc = formatAddress(f.pc);

        if (f.segmentId >= 0) {
          const values = await this.fileParser.resolveFileLine(
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
            sf.instructionPointerReference = formatHexadecimal(f.pc);
            stackFrames.push(sf);
            stackFrameDone = true;
          }
        }

        if (!stackFrameDone) {
          let line = pc;
          if (this.gdbProxy.isCPUThread(thread)) {
            const dCode = this.disassembledCache.get(f.pc);
            if (dCode) {
              line = dCode;
            } else {
              // Get the disassembled line
              line += ": ";
              try {
                const memory = await this.gdbProxy.getMemory(f.pc, 10);
                const { code: disassembled } = await disassemble(memory);
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
                const cDis = disassembleCopper(memory);
                line = line + cDis.join("\n").split("    ")[0];
                this.disassembledCopperCache.set(f.pc, line);
              } catch (err) {
                console.error("Error ignored: " + (err as Error).message);
              }
            }
          }
          // The the stack frame from the manager
          const stackFrame = await this.disassemblyManager.getStackFrame(
            f.index,
            f.pc,
            line,
            this.gdbProxy.isCopperThread(thread)
          );
          stackFrames.push(stackFrame);
        }
      }

      response.body = { stackFrames, totalFrames };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async updateDisassembledView(_: number) {
    // NOOP on this implementation- needed for vs-code
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    const scopes: Scope[] = [];
    scopes.push({
      name: "Registers",
      variablesReference: this.variableHandles.create(
        FsUAEDebugSession.PREFIX_REGISTERS + args.frameId
      ),
      expensive: false,
    });
    scopes.push(
      new Scope(
        "Segments",
        this.variableHandles.create(
          FsUAEDebugSession.PREFIX_SEGMENTS + args.frameId
        ),
        true
      )
    );
    scopes.push(
      new Scope(
        "Symbols",
        this.variableHandles.create(
          FsUAEDebugSession.PREFIX_SYMBOLS + args.frameId
        ),
        true
      )
    );
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    // Try to look up stored reference
    const variables = this.variableRefMap.get(args.variablesReference);
    if (variables) {
      response.body = { variables };
      return this.sendResponse(response);
    }

    const id = this.variableHandles.get(args.variablesReference);
    if (!id) {
      return this.sendStringErrorResponse(response, "No id to variable");
    }

    await this.gdbProxy.waitConnected();

    // Register?
    if (id.startsWith(FsUAEDebugSession.PREFIX_REGISTERS)) {
      try {
        const frameId = parseInt(id.substring(10));
        const registers = await this.gdbProxy.registers(frameId, null);
        const variables = new Array<DebugProtocol.Variable>();
        const srVariables = new Array<DebugProtocol.Variable>();
        const srVRef = this.variableHandles.create(
          "status_register_" + frameId
        );
        for (const r of registers) {
          if (r.name.startsWith("SR_")) {
            const name = r.name.replace("SR_", "");
            srVariables.push({
              name,
              type: "register",
              value: this.formatVariable(name, r.value, NumberFormat.DECIMAL),
              variablesReference: 0,
            });
          } else {
            variables.push({
              name: r.name,
              type: "register",
              value: this.formatVariable(r.name, r.value),
              variablesReference: r.name.startsWith("sr") ? srVRef : 0,
              memoryReference: r.value.toString(),
            });
          }
        }
        this.variableRefMap.set(srVRef, srVariables);
        response.body = { variables };
        return this.sendResponse(response);
      } catch (err) {
        this.sendStringErrorResponse(response, (err as Error).message);
      }
    }

    // Segment?
    if (id.startsWith(FsUAEDebugSession.PREFIX_SEGMENTS)) {
      const variables = new Array<DebugProtocol.Variable>();
      const segments = this.gdbProxy.getSegments();
      if (segments) {
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i];
          const name = `Segment #${i}`;
          variables.push({
            name,
            type: "segment",
            value: `${this.formatVariable(name, s.address)} {size:${s.size}}`,
            variablesReference: 0,
            memoryReference: s.address.toString(),
          });
        }
        response.body = { variables };
      } else {
        response.success = false;
        response.message = "No Segments found";
      }
      return this.sendResponse(response);
    }

    // Symbol?
    if (id.startsWith(FsUAEDebugSession.PREFIX_SYMBOLS)) {
      const variables = new Array<DebugProtocol.Variable>();
      const symbolsList = Array.from(this.symbolsMap.entries()).sort(
        compareStringsLowerCase
      );
      for (const [name, value] of symbolsList) {
        variables.push({
          name,
          type: "symbol",
          value: this.formatVariable(name, value),
          variablesReference: 0,
          memoryReference: value.toString(),
        });
      }
      response.body = { variables };
      return this.sendResponse(response);
    }

    this.sendStringErrorResponse(response, "Unknown variable");
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
    this.emulator.destroy();
    // this.sendEvent(new TerminatedEvent());
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
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      await this.gdbProxy.continueExecution(thread);
      response.body = {
        allThreadsContinued: false,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      await this.gdbProxy.stepToRange(thread, 0, 0);
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      await this.gdbProxy.stepIn(thread);
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    await this.gdbProxy.waitConnected();
    const thread = this.gdbProxy.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      const { frames } = await this.gdbProxy.stack(thread);
      const { pc } = frames[1];
      const startAddress = pc + 1;
      const endAddress = pc + 10;
      await this.gdbProxy.stepToRange(thread, startAddress, endAddress);
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
        data: hexToBase64(memory),
        //unreadableBytes: unreadable
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
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

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    // Register name?
    const matches = /^([ad][0-7]|pc|sr)$/i.exec(args.expression);
    if (matches) {
      // Watch?
      if (args.expression.startsWith("a") && args.context === "watch") {
        const format = "m ${symbol},100,2,4";
        args.expression = format.replace("symbol", args.expression);
        return this.evaluateRequestGetMemory(response, args);
      } else {
        return this.evaluateRequestRegister(response, args);
      }
    }
    // Get memory?
    if (args.expression.startsWith("m")) {
      return this.evaluateRequestGetMemory(response, args);
    }
    // Set memory?
    if (args.expression.startsWith("M")) {
      return this.evaluateRequestSetMemory(response, args);
    }
    // Symbol name?
    if (this.symbolsMap.has(args.expression)) {
      const format =
        args.context === "watch" ? "m ${symbol},104,2,4" : "m ${symbol},24,2,4";
      args.expression = format.replace("symbol", args.expression);
      return this.evaluateRequestGetMemory(response, args);
    }
    // Evaluate
    try {
      const address = await evaluateExpression(
        args.expression,
        args.frameId,
        this
      );
      response.body = {
        result: formatHexadecimal(address),
        type: "string",
        variablesReference: 0,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
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
      const format =
        this.variableFormatterMap.get(args.expression) ||
        NumberFormat.HEXADECIMAL;
      const strValue = formatNumber(valueNumber, format);
      response.body = {
        result: strValue,
        variablesReference: 0,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
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

    if (!matches) {
      return this.sendStringErrorResponse(
        response,
        "Expression not recognized"
      );
    }

    const length = parseInt(matches[2]);
    if (length === null) {
      this.sendStringErrorResponse(response, "Invalid memory dump expression");
    }

    let rowLength = 4;
    let wordLength = 4;
    let mode = "ab";
    if (matches.length > 5 && matches[4] && matches[5]) {
      wordLength = parseInt(matches[4]);
      rowLength = parseInt(matches[5]);
    }
    if (matches.length > 7 && matches[7]) {
      mode = matches[7];
    }

    try {
      // replace the address if it is a variable
      const address = await evaluateExpression(matches[1], args.frameId, this);
      // ask for memory dump
      await this.gdbProxy.waitConnected();
      const memory = await this.gdbProxy.getMemory(address, length);
      let key = this.variableExpressionMap.get(args.expression);
      if (!key) {
        key = this.variableHandles.create(args.expression);
      }
      const startAddress = address;
      if (mode !== "d") {
        const [firstRow, variables] = processOutputFromMemoryDump(
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
        const constKey = key;
        // disassemble the code
        const { firstRow, variables } = await disassemble(memory, startAddress);
        this.variableRefMap.set(constKey, variables);
        this.variableExpressionMap.set(args.expression, constKey);
        response.body = {
          result: firstRow,
          type: "array",
          variablesReference: constKey,
        };
        this.sendResponse(response);
      }
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async evaluateRequestSetMemory(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    const matches = /M\s*([{}$#0-9a-z_]+)\s*=\s*([0-9a-z_]+)/i.exec(
      args.expression
    );
    if (!matches) {
      return this.sendStringErrorResponse(
        response,
        "Expression not recognized"
      );
    }

    const addrStr = matches[1];
    const data = matches[2];
    if (!addrStr || !data || !data.length) {
      this.sendStringErrorResponse(response, "Invalid memory set expression");
    }

    try {
      // replace the address if it is a variable
      const address = await evaluateExpression(addrStr, args.frameId, this);
      await this.gdbProxy.waitConnected();
      await this.gdbProxy.setMemory(address, data);
      args.expression = "m" + addrStr + "," + data.length.toString(16);
      return this.evaluateRequestGetMemory(response, args);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
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
   * @param segments The list of returned segments from the debugger
   */
  public updateSegments(segments: Array<GdbSegment>): void {
    if (!this.fileParser) {
      return;
    }
    const lastPos = this.fileParser.hunks.length;
    for (let posSegment = 0; posSegment < lastPos; posSegment++) {
      // Segments in order of file
      const hunk = this.fileParser.hunks[posSegment];
      let segment: GdbSegment;
      let address: number;
      if (posSegment >= segments.length) {
        // Segment not declared by the protocol
        segment = {
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

  //---- variable resolver

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
    return this.formatVariable(variableName, value);
  }

  public async getVariableValueAsNumber(
    variableName: string,
    frameIndex?: number
  ): Promise<number> {
    // Is it a register?
    const registerMatch = /^([ad][0-7]|pc|sr)$/i.exec(variableName);
    if (registerMatch) {
      await this.gdbProxy.waitConnected();
      const values = await this.gdbProxy.getRegister(variableName, frameIndex);
      return parseInt(values[0], 16);
    }
    // Is it a symbol?
    let address = this.symbolsMap.get(variableName);
    if (address !== undefined) {
      return address;
    }
    // Is it a standard register
    address = getCustomAddress(variableName.toUpperCase());
    if (address !== undefined) {
      return address;
    }
    throw new Error("Unknown symbol " + variableName);
  }

  //---- helpers

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

  protected formatVariable(
    variableName: string,
    value: number,
    defaultFormat: NumberFormat = NumberFormat.HEXADECIMAL
  ): string {
    const format = this.variableFormatterMap.get(variableName) || defaultFormat;
    return formatNumber(value, format);
  }

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
    segments: GdbSegment[]
  ): Promise<[Source, number] | undefined> {
    if (this.fileParser) {
      const selectedSegment = this.findSegmentForAddress(address, segments);
      if (selectedSegment) {
        const values = await this.fileParser.resolveFileLine(
          selectedSegment.id,
          address - selectedSegment.address
        );
        if (values) {
          return [this.createSource(values[0]), values[1]];
        }
      }
    }
  }

  protected findSegmentForAddress(
    address: number,
    segments: GdbSegment[]
  ): GdbSegment | undefined {
    for (const segment of segments) {
      if (this.isAddressInSegment(address, segment)) {
        return segment;
      }
    }
  }

  protected isAddressInSegment(address: number, segment: GdbSegment): boolean {
    return (
      address >= segment.address && address < segment.address + segment.size
    );
  }
}
