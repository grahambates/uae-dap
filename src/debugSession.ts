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
import { openSync } from "temp";
import * as fs from "fs/promises";

import { GdbProxy, GdbSegment, GdbHaltStatus } from "./gdb";
import { FileParser } from "./parsing/fileParser";
import { evaluateExpression } from "./expressions";
import { DisassemblyManager, DisassembleAddressArguments } from "./disassembly";
import { BreakpointManager } from "./breakpointManager";
import { customRegisterAddresses } from "./customRegisters";
import { disassemble, disassembleCopper } from "./disassembly";
import {
  base64ToHex,
  chunk,
  compareStringsLowerCase,
  formatAddress,
  formatHexadecimal,
  formatNumber,
  hexStringToASCII,
  hexToBase64,
  NumberFormat,
} from "./utils/strings";
import { Emulator } from "./emulator";
import Vasm from "./vasm";

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
  /** Options for vasm assembler */
  vasm?: VasmOptions;
}

export interface VasmOptions {
  /** Enable extracting constants from source files using vasm */
  parseSource?: boolean;
  /** vasm binary - will use wasm if not set */
  binaryPath?: string;
  /** additional cli args for vasm - add include paths etc */
  args?: string[];
}

export interface VariableDisplayFormatRequest {
  /** info of the variable */
  variableInfo: { variable: { name: string; value: string } };
  /** Requested format */
  format: NumberFormat;
}

export enum VariableType {
  Registers,
  Segments,
  Symbols,
  StatusRegister,
  Expression,
}

export interface VariablesReference {
  type: VariableType;
  frameId: number;
}

export class FsUAEDebugSession extends DebugSession {
  /** Timeout of the mutex */
  protected static readonly MUTEX_TIMEOUT = 100000;

  /** Proxy to Gdb */
  protected gdb: GdbProxy;
  /** Breakpoint manager */
  protected breakpoints: BreakpointManager;
  /** Emulator instance */
  protected emulator: Emulator;

  /** Variable reference handles */
  protected variableReferences = new Handles<VariablesReference>();
  /** Variables lookup by handle */
  protected referencedVariables = new Map<number, DebugProtocol.Variable[]>();
  /** Expression string to variable reference map */
  protected expressionToVariablesReference = new Map<string, number>();
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
  /** Lazy loaded constants extracted from current file source */
  protected sourceConstants?: Record<string, number>;
  /** Options for vasm assembler */
  protected vasmOptions?: VasmOptions;

  /**
   * Creates a new debug adapter that is used for one debug session.
   * We configure the default implementation of a debug adapter here.
   */
  public constructor() {
    super();
    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    this.gdb = new GdbProxy();
    this.emulator = new Emulator();
    this.gdb.setMutexTimeout(FsUAEDebugSession.MUTEX_TIMEOUT);
    this.initProxy();
    this.disassemblyManager = new DisassemblyManager(this.gdb, this);
    this.breakpoints = new BreakpointManager(this.gdb, this.disassemblyManager);
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
    this.disassemblyManager = new DisassemblyManager(this.gdb, this);
    this.breakpoints = new BreakpointManager(this.gdb, this.disassemblyManager);
    this.breakpoints.setMutexTimeout(1000);
  }

  /**
   * Returns the breakpoint manager (for tests)
   * @return the breakpoint manager
   */
  public getBreakpointManager(): BreakpointManager {
    return this.breakpoints;
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
    this.gdb.on("segmentsUpdated", this.updateSegments.bind(this));
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
    response.body.supportsCompletionsRequest = true;

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

      this.breakpoints.setFileParser(this.fileParser);
      this.breakpoints.checkPendingBreakpointsAddresses();

      if (args.exceptionMask) {
        this.breakpoints.setExceptionMask(args.exceptionMask);
      }
      this.trace = args.trace ?? false;

      this.vasmOptions = args.vasm;

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

  protected customRequest(
    command: string,
    response: DebugProtocol.Response,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      if (args.memoryReference && (args.offset || args.instructionOffset)) {
        const segments = this.gdb.getSegments();
        if (segments) {
          firstAddress = parseInt(args.memoryReference);
          if (args.offset) {
            firstAddress = firstAddress - args.offset;
          }
          const segment = this.findSegmentForAddress(firstAddress, segments);
          if (segment) {
            newArgs.memoryReference = segment.address.toString();
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
    const copper =
      this.disassembledCopperCache.get(parseInt(args.memoryReference)) !==
      undefined;
    const dArgs = { ...args, copper };
    return this.disassembleRequestInner(response, dArgs);
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments
  ) {
    const debugBreakPoints = new Array<DebugProtocol.Breakpoint>();
    // clear all breakpoints for this file
    await this.breakpoints.clearInstructionBreakpoints();
    // set and verify breakpoint locations
    if (args.breakpoints) {
      for (const reqBp of args.breakpoints) {
        const debugBp = this.breakpoints.createInstructionBreakpoint(
          parseInt(reqBp.instructionReference)
        );
        try {
          const modifiedBp = await this.breakpoints.setBreakpoint(debugBp);
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
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    // clear all breakpoints for this file
    await this.breakpoints.clearBreakpoints(args.source);
    // set and verify breakpoint locations
    if (args.breakpoints) {
      for (const reqBp of args.breakpoints) {
        const debugBp = this.breakpoints.createBreakpoint(
          args.source,
          reqBp.line
        );
        try {
          const modifiedBp = await this.breakpoints.setBreakpoint(debugBp);
          breakpoints.push(modifiedBp);
        } catch (err) {
          breakpoints.push(debugBp);
        }
      }
    }
    // send back the actual breakpoint positions
    response.body = { breakpoints };
    response.success = true;
    this.sendResponse(response);
  }

  protected async threadsRequest(
    response: DebugProtocol.ThreadsResponse
  ): Promise<void> {
    try {
      await this.gdb.waitConnected();
      const threadIds = await this.gdb.getThreadIds();
      const threads = threadIds.map(
        (t) => new Thread(t.getId(), this.gdb.getThreadDisplayName(t))
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
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }

    try {
      const { frames, count: totalFrames } = await this.gdb.stack(thread);
      const stackFrames = [];
      let updatedView = false;

      for (const f of frames) {
        if (!updatedView && this.gdb.isCPUThread(thread)) {
          // Update the cpu view
          this.updateDisassembledView(f.pc);
          updatedView = true;
          this.breakpoints.checkTemporaryBreakpoints(f.pc);
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
          if (this.gdb.isCPUThread(thread)) {
            const dCode = this.disassembledCache.get(f.pc);
            if (dCode) {
              line = dCode;
            } else {
              // Get the disassembled line
              line += ": ";
              try {
                const memory = await this.gdb.getMemory(f.pc, 10);
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
          } else if (this.gdb.isCopperThread(thread)) {
            const dCopperCode = this.disassembledCopperCache.get(f.pc);
            if (dCopperCode) {
              line = dCopperCode;
            } else {
              // Get the disassembled line
              line += ": ";
              try {
                const memory = await this.gdb.getMemory(f.pc, 10);
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
            this.gdb.isCopperThread(thread)
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async updateDisassembledView(_: number) {
    // NOOP on this implementation- needed for vs-code
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    { frameId }: DebugProtocol.ScopesArguments
  ): void {
    response.body = {
      scopes: [
        new Scope(
          "Registers",
          this.variableReferences.create({
            type: VariableType.Registers,
            frameId,
          }),
          false
        ),
        new Scope(
          "Segments",
          this.variableReferences.create({
            type: VariableType.Segments,
            frameId,
          }),
          true
        ),
        new Scope(
          "Symbols",
          this.variableReferences.create({
            type: VariableType.Symbols,
            frameId,
          }),
          true
        ),
      ],
    };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    // Try to look up stored reference
    let variables = this.referencedVariables.get(args.variablesReference);
    if (variables) {
      response.body = { variables };
      return this.sendResponse(response);
    }

    // Get reference info in order to populate variables
    const ref = this.variableReferences.get(args.variablesReference);
    if (!ref) {
      return this.sendStringErrorResponse(response, "Reference not found");
    }
    const { type, frameId } = ref;

    await this.gdb.waitConnected();

    switch (type) {
      case VariableType.Registers:
        try {
          variables = await this.getRegisterVariables(frameId);
        } catch (err) {
          return this.sendStringErrorResponse(response, (err as Error).message);
        }
        break;
      case VariableType.Segments:
        variables = this.getSegmentVariables();
        break;
      case VariableType.Symbols:
        variables = this.getSymbolVariables();
        break;
      default:
        return this.sendStringErrorResponse(
          response,
          "Invalid variable reference"
        );
    }
    response.body = { variables };
    return this.sendResponse(response);
  }

  protected async getRegisterVariables(
    frameId: number
  ): Promise<DebugProtocol.Variable[]> {
    const registers = await this.gdb.registers(frameId);

    // Stack register properties go in their own variables array to be fetched later by reference
    const sr = registers
      .filter(({ name }) => name.startsWith("SR_"))
      .map(({ name, value }) => ({
        name: name.substring(3),
        type: "register",
        value: this.formatVariable(name, value, NumberFormat.DECIMAL),
        variablesReference: 0,
        memoryReference: value.toString(),
      }));

    const srVRef = this.variableReferences.create({
      type: VariableType.StatusRegister,
      frameId,
    });
    this.referencedVariables.set(srVRef, sr);

    // All other registers returned
    return registers
      .filter(({ name }) => !name.startsWith("SR_"))
      .map(({ name, value }) => ({
        name,
        type: "register",
        value: this.formatVariable(name, value),
        variablesReference: name.startsWith("sr") ? srVRef : 0, // Link SR to its properties
        memoryReference: value.toString(),
      }));
  }

  protected getSegmentVariables(): DebugProtocol.Variable[] {
    const segments = this.gdb.getSegments() ?? [];
    return segments.map((s, i) => {
      const name = `Segment #${i}`;
      return {
        name,
        type: "segment",
        value: `${this.formatVariable(name, s.address)} {size:${s.size}}`,
        variablesReference: 0,
        memoryReference: s.address.toString(),
      };
    });
  }

  protected getSymbolVariables(): DebugProtocol.Variable[] {
    return Array.from(this.symbolsMap.entries())
      .sort(compareStringsLowerCase)
      .map(([name, value]) => ({
        name,
        type: "symbol",
        value: this.formatVariable(name, value),
        variablesReference: 0,
        memoryReference: value.toString(),
      }));
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments
  ): Promise<void> {
    const scopeRef = this.variableReferences.get(args.variablesReference);
    if (scopeRef?.type !== VariableType.Registers) {
      return this.sendStringErrorResponse(
        response,
        "This variable cannot be set"
      );
    }
    try {
      const newValue = await this.gdb.setRegister(args.name, args.value);
      response.body = {
        value: newValue,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): Promise<void> {
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      await this.gdb.continueExecution(thread);
      response.body = { allThreadsContinued: false };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      await this.gdb.stepToRange(thread, 0, 0);
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      await this.gdb.stepIn(thread);
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(args.threadId);
    if (!thread) {
      return this.sendStringErrorResponse(response, "Unknown thread");
    }
    try {
      const { frames } = await this.gdb.stack(thread);
      const { pc } = frames[1];
      await this.gdb.stepToRange(thread, pc + 1, pc + 10);
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
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    { expression, frameId, context }: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    await this.gdb.waitConnected();
    let variables: DebugProtocol.Variable[] | undefined;
    let result: string | undefined;

    // Find expression type:
    const isRegister = expression.match(/^([ad][0-7]|pc|sr)$/i) !== null;
    const isMemRead = expression.match(/^m\s/) !== null;
    const isMemWrite = expression.match(/^M\s/) !== null;
    const isSymbol = this.symbolsMap.has(expression);

    try {
      switch (true) {
        case isRegister: {
          const [address] = await this.gdb.getRegister(expression, frameId);
          if (expression.startsWith("a") && context === "watch") {
            variables = await this.readMemoryAsVariables(address, 100, 2, 4);
          } else {
            result = this.formatVariable(expression, address);
          }
          break;
        }
        case isMemWrite:
          variables = await this.writeMemoryExpression(expression, frameId);
          break;
        case isMemRead:
          variables = await this.readMemoryExpression(expression, frameId);
          break;
        case isSymbol: {
          const address = <number>this.symbolsMap.get(expression);
          const length = context === "watch" ? 104 : 24;
          variables = await this.readMemoryAsVariables(address, length, 2, 4);
          break;
        }
        // Evaluate
        default: {
          const address = await evaluateExpression(expression, frameId, this);
          result = formatHexadecimal(address);
        }
      }

      // Build response for either single value or array
      if (result) {
        response.body = {
          result,
          type: "string",
          variablesReference: 0,
        };
      }
      if (variables) {
        const variablesReference = this.variableReferences.create({
          type: VariableType.Expression,
          frameId: frameId ?? 0,
        });
        this.referencedVariables.set(variablesReference, variables);

        response.body = {
          result: variables[0].value.replace(
            /^[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}\s+/,
            ""
          ),
          type: "array",
          variablesReference,
        };
      }

      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async writeMemoryExpression(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    const matches =
      /M\s*(?<addr>[{}$#0-9a-z_]+)\s*=\s*(?<data>[0-9a-z_]+)/i.exec(expression);
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expression not recognized");
    }
    const address = await evaluateExpression(groups.addr, frameId, this);
    // const data = await evaluateExpression(groups.data, frameId, this);
    await this.gdb.setMemory(address, groups.data);
    return this.readMemoryAsVariables(address, groups.data.length); // TODO get size of data
  }

  protected async readMemoryExpression(
    expression: string,
    frameId?: number
  ): Promise<DebugProtocol.Variable[]> {
    // Parse expression
    const matches =
      /m\s*(?<address>[^,]+)(,\s*(?<length>(?!(d|c|ab?|ba?)$)[^,]+))?(,\s*(?<wordLength>(?!(d|c|ab?|ba?)$)[^,]+))?(,\s*(?<rowLength>(?!(d|c|ab?|ba?)$)[^,]+))?(,\s*(?<mode>(d|c|ab?|ba?)))?/i.exec(
        expression
      );
    const groups = matches?.groups;
    if (!groups) {
      throw new Error("Expression not recognized");
    }

    // Evaluate match groups:
    // All of these parameters can contain expressions
    const address = await evaluateExpression(groups.address, frameId, this);
    const length = groups.wordLength
      ? await evaluateExpression(groups.length, frameId, this)
      : 16;
    const wordLength = groups.wordLength
      ? await evaluateExpression(groups.wordLength, frameId, this)
      : 4;
    const rowLength = groups.rowLength
      ? await evaluateExpression(groups.rowLength, frameId, this)
      : 4;
    const mode = groups.mode ?? "ab";

    if (mode === "d") {
      return await this.disassembleAsVariables(address, length);
    } else if (mode === "c") {
      return await this.disassembleCopperAsVariables(address, length);
    } else {
      return await this.readMemoryAsVariables(
        address,
        length,
        wordLength,
        rowLength,
        mode
      );
    }
  }

  protected async readMemoryAsVariables(
    address: number,
    length = 16,
    wordLength = 4,
    rowLength = 4,
    mode = "ab"
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.getMemory(address, length);
    let firstRow = "";
    const variables = new Array<DebugProtocol.Variable>();
    const chunks = chunk(memory.toString(), wordLength * 2);
    let i = 0;
    let rowCount = 0;
    let row = "";
    let nextAddress = address;
    let lineAddress = address;
    while (i < chunks.length) {
      if (rowCount > 0) {
        row += " ";
      }
      row += chunks[i];
      nextAddress += chunks[i].length / 2;
      if (rowCount >= rowLength - 1 || i === chunks.length - 1) {
        if (mode.indexOf("a") >= 0) {
          const asciiText = hexStringToASCII(row.replace(/\s+/g, ""), 2);
          if (mode.indexOf("b") >= 0) {
            if (i === chunks.length - 1 && rowCount < rowLength - 1) {
              const chunksMissing = rowLength - 1 - rowCount;
              const padding = chunksMissing * wordLength * 2 + chunksMissing;
              for (let j = 0; j < padding; j++) {
                row += " ";
              }
            }
            row += " | ";
          } else {
            row = "";
          }
          row += asciiText;
        }
        variables.push({
          value: row,
          name: lineAddress.toString(16).padStart(8, "0"),
          variablesReference: 0,
        });
        if (firstRow.length <= 0) {
          firstRow = row;
        }
        rowCount = 0;
        lineAddress = nextAddress;
        row = "";
      } else {
        rowCount++;
      }
      i++;
    }
    return variables;
  }

  protected async disassembleAsVariables(
    address: number,
    length: number
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.getMemory(address, length);
    const { instructions } = await disassemble(memory, address);

    return instructions.map(({ instruction, address, instructionBytes }) => ({
      value: (instructionBytes ?? "").padEnd(26) + instruction,
      name: address,
      variablesReference: 0,
    }));
  }

  protected async disassembleCopperAsVariables(
    address: number,
    length: number
  ): Promise<DebugProtocol.Variable[]> {
    const memory = await this.gdb.getMemory(address, length);

    return disassembleCopper(memory).map((inst, i) => ({
      value: inst.toString(),
      name: formatAddress(address + i * 4),
      variablesReference: 0,
    }));
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments
  ): Promise<void> {
    await this.gdb.waitConnected();
    const thread = this.gdb.getThread(args.threadId);
    if (thread) {
      try {
        await this.gdb.pause(thread);
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
        await this.breakpoints.setExceptionBreakpoint();
        response.success = true;
        this.sendResponse(response);
      } else {
        await this.breakpoints.removeExceptionBreakpoint();
        response.success = true;
        this.sendResponse(response);
      }
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments
  ): Promise<void> {
    try {
      const vars = await this.getVariables(args.frameId);
      response.body = {
        targets: Object.keys(vars)
          .filter((key) => key.startsWith(args.text))
          .map((label) => ({ label })),
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendStringErrorResponse(response, (err as Error).message);
    }
  }

  public terminate(): void {
    this.gdb.destroy();
    this.emulator.destroy();
  }

  public shutdown(): void {
    this.terminate();
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
        address = this.gdb.addSegment(segment);
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

  public async getVariables(frameId?: number): Promise<Record<string, number>> {
    await this.gdb.waitConnected();
    const registers = await this.gdb.registers(frameId || null);
    const registerEntries = registers.reduce<Record<string, number>>(
      (acc, v) => {
        acc[v.name] = v.value;
        return acc;
      },
      {}
    );
    const sourceConstants = await this.getSourceConstants();

    return {
      ...Object.fromEntries(this.symbolsMap),
      ...customRegisterAddresses,
      ...sourceConstants,
      ...registerEntries,
    };
  }

  /**
   * Lazy load constants from parsed source files
   */
  protected async getSourceConstants(): Promise<Record<string, number>> {
    if (this.sourceConstants) {
      return this.sourceConstants;
    }
    const constants: Record<string, number> = {};
    if (this.vasmOptions?.parseSource === false || !this.fileParser) {
      return constants;
    }

    // Find the first source file from each hunk
    const sourceFiles = new Set<string>();
    this.fileParser.hunks.forEach((h) => {
      h.lineDebugInfo?.length && sourceFiles.add(h.lineDebugInfo[0].name);
    });

    // Use vasm 'test' output module to list constants
    const vasm = new Vasm(this.vasmOptions?.binaryPath);
    await Promise.all(
      Array.from(sourceFiles).map(async (src) => {
        const outFile = openSync(basename(src));
        const userArgs = this.vasmOptions?.args ?? [];
        try {
          const args = [
            ...userArgs,
            "-Ftest",
            "-quiet",
            "-o",
            outFile.path,
            src,
          ];
          await vasm.run(args);
          const output = (await fs.readFile(outFile.path)).toString();
          Array.from(
            output.matchAll(
              /^([^ ]+) EXPR\((-?[0-9]+)=0x[0-9a-f]+\) (UNUSED )?EQU/gm
            )
          ).forEach((m) => (constants[m[1]] = parseInt(m[2], 10)));
        } finally {
          fs.unlink(outFile.path);
        }
      })
    );
    this.sourceConstants = constants;
    return constants;
  }

  //---- variable resolver

  public async getMemory(address: number, size = 4): Promise<number> {
    await this.gdb.waitConnected();
    const mem = await this.gdb.getMemory(address, size);
    return parseInt(mem, 16);
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
    const segments = this.gdb.getSegments();
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
