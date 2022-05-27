import { DebugClient } from "@vscode/debugadapter-testsupport";
import { DebugProtocol } from "@vscode/debugprotocol";
import { LaunchRequestArguments, FsUAEDebugSession } from "../src/debugSession";
import * as net from "net";
import * as path from "path";
import {
  anyString,
  instance,
  when,
  anything,
  mock,
  anyNumber,
  reset,
  verify,
  resetCalls,
  capture,
  anyFunction,
} from "@johanblumenberg/ts-mockito";

import {
  GdbEvents,
  GdbProxy,
  GdbThread,
  GdbAmigaSysThreadIdFsUAE,
  GdbBreakpoint,
  GdbBreakpointType,
} from "../src/gdb";
import { BreakpointManager } from "../src/breakpoints";
import { Emulator } from "../src/emulator";

type Callback = (...args: unknown[]) => void;

const anyArray = expect.any(Array);

describe("Node Debug Adapter", () => {
  const PROJECT_ROOT = path.join(__dirname, "..").replace(/\\+/g, "/");
  const FIXTURES_DIR = path
    .join(PROJECT_ROOT, "test", "fixtures")
    .replace(/\\+/g, "/");
  const FSUAE_ROOT = path.join(FIXTURES_DIR, "fs-uae").replace(/\\+/g, "/");
  const UAE_DRIVE = path.join(FSUAE_ROOT, "hd0").replace(/\\+/g, "/");
  const SOURCE_FILE_NAME = path
    .join(FIXTURES_DIR, "gencop.s")
    .replace(/\\+/g, "/");

  const launchArgs: LaunchRequestArguments = {
    program: path.join(UAE_DRIVE, "gencop"),
    stopOnEntry: false,
    serverName: "localhost",
    serverPort: 6860,
    startEmulator: true,
    emulator: "fs-uae",
    emulatorOptions: [],
    sourceFileMap: {
      "C:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example":
        FIXTURES_DIR,
    },
  };

  const launchArgsStopEntry: LaunchRequestArguments = {
    ...launchArgs,
    stopOnEntry: true,
  };

  let dc: DebugClient;
  const callbacks = new Map<string, Callback>();
  const th = new GdbThread(0, GdbAmigaSysThreadIdFsUAE.CPU);
  const thCop = new GdbThread(1, GdbAmigaSysThreadIdFsUAE.COP);
  const threadId = 0;

  let gdbProxy: GdbProxy;
  let emulator: Emulator;
  let session: FsUAEDebugSession;
  let server: net.Server;
  let onExit: undefined | (() => void);

  beforeAll(async () => {
    GdbThread.setSupportMultiprocess(false);
    // Mock emulator
    emulator = mock(Emulator);
    when(emulator.run(anything())).thenCall(async (args) => {
      onExit = args.onExit;
    });
    when(emulator.destroy()).thenCall(() => {
      if (onExit) {
        onExit();
        onExit = undefined;
      }
    });
  });

  beforeEach(async () => {
    // Mock GDB proxy
    gdbProxy = mock(GdbProxy);
    when(gdbProxy.on(anyString() as keyof GdbEvents, anyFunction())).thenCall(
      (event: string, callback: Callback) => {
        callbacks.set(event, callback);
        return gdbProxy;
      }
    );
    when(gdbProxy.waitConnected()).thenResolve();
    when(gdbProxy.connect(anyString(), anyNumber())).thenResolve();
    when(gdbProxy.isConnected()).thenReturn(true);
    when(gdbProxy.getThread(th.getId())).thenReturn(th);
    when(gdbProxy.getThread(thCop.getId())).thenReturn(thCop);
    when(gdbProxy.getThreadIds()).thenResolve([th, thCop]);

    // Start server on a random port
    server = net
      .createServer((socket) => {
        session = new FsUAEDebugSession();
        session.setTestContext(instance(gdbProxy), instance(emulator));
        session.setRunAsServer(true);
        session.start(socket, socket);
      })
      .listen();

    // Because we start on a port, the client connects to server instead of launching adapter
    dc = new DebugClient("not", "used", "ignore");
    const address = <net.AddressInfo>server.address();
    return dc.start(address.port);
  });

  afterEach(async () => {
    reset(gdbProxy);
    await dc.stop();
    session.shutdown();
    server.close();
  });

  describe("basic", () => {
    it("unknown request should produce error", async () => {
      await expect(() => dc.send("illegal_request")).rejects.toThrow();
    });
  });

  describe("initialize", () => {
    it("should return supported features", async () => {
      await dc.initializeRequest().then(({ body }) => {
        expect(body?.supportsConfigurationDoneRequest).toBe(false);
        expect(body?.supportsEvaluateForHovers).toBe(true);
        expect(body?.supportsStepBack).toBe(false);
        expect(body?.supportsRestartFrame).toBe(false);
        expect(body?.supportsConditionalBreakpoints).toBe(false);
        expect(body?.supportsSetVariable).toBe(true);
      });
    });

    it("should produce error for invalid 'pathFormat'", async () => {
      const args = {
        adapterID: "mock",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "url",
      };
      await expect(dc.initializeRequest(args)).rejects.toThrow();
    });
  });

  describe("launch", () => {
    it("should run program to the end", async () => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        callbacks.get("end")?.();
      });
      await expect(
        Promise.all([
          dc.configurationSequence(),
          dc.launch(launchArgs),
          dc.waitForEvent("terminated"),
        ])
      ).resolves.toEqual(anyArray);
    });

    it("should stop on entry", () => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnEntry")?.(threadId), 1);
      });
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: 1,
          segmentId: 0,
          offset: 0,
          pc: 0,
          stackFrameIndex: 0,
        },
      ]);

      return expect(
        Promise.all([
          dc.configurationSequence(),
          dc.launch(launchArgsStopEntry),
          dc.assertStoppedLocation("entry", { line: 32 }),
        ])
      ).resolves.toEqual(anyArray);
    });
  });

  describe("setBreakpoints", () => {
    it("should stop on a breakpoint", async () => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnBreakpoint")?.(threadId), 1);
      });
      when(gdbProxy.setBreakpoint(anything())).thenCall(async (bp) => {
        bp.verified = true;
        callbacks.get("breakpointValidated")?.(bp);
      });
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: 1,
          segmentId: 0,
          offset: 4,
          pc: 10,
          stackFrameIndex: 0,
        },
      ]);
      when(gdbProxy.registers(anything())).thenResolve([
        { name: "d0", value: 1 },
      ]);

      await Promise.all([dc.configurationSequence(), dc.launch(launchArgs)]);
      return expect(
        dc.hitBreakpoint(launchArgs, {
          path: SOURCE_FILE_NAME,
          line: 33,
        })
      ).resolves.toEqual(anyArray);
    });

    it("hitting a lazy breakpoint should send a breakpoint event", async () => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnBreakpoint")?.(threadId), 1);
        setTimeout(() => {
          callbacks.get("breakpointValidated")?.({
            id: 0,
            segmentId: 0,
            offset: 0,
            verified: true,
          });
        }, 2);
      });
      when(gdbProxy.setBreakpoint(anything())).thenCall(async (bp) => {
        bp.verified = true;
        callbacks.get("breakpointValidated")?.(bp);
      });
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: 1,
          segmentId: 0,
          offset: 4,
          pc: 10,
          stackFrameIndex: 0,
        },
      ]);

      await Promise.all([dc.configurationSequence(), dc.launch(launchArgs)]);
      return Promise.all([
        dc.hitBreakpoint(launchArgsStopEntry, {
          path: SOURCE_FILE_NAME,
          line: 33,
        }),
        dc
          .waitForEvent("breakpoint")
          .then(function (event: DebugProtocol.Event) {
            expect(event.body.breakpoint.verified).toBe(true);
          }),
      ]);
    });
  });

  describe("stepping", () => {
    beforeEach(() => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnEntry")?.(threadId), 1);
      });
    });

    it("should step", async () => {
      when(gdbProxy.stack(th))
        .thenResolve([
          {
            index: 1,
            segmentId: 0,
            offset: 0,
            pc: 0,
            stackFrameIndex: 0,
          },
        ])
        .thenResolve([
          {
            index: 1,
            segmentId: 0,
            offset: 4,
            pc: 4,
            stackFrameIndex: 0,
          },
        ])
        .thenResolve([
          {
            index: 1,
            segmentId: 0,
            offset: 8,
            pc: 8,
            stackFrameIndex: 0,
          },
        ]);
      when(gdbProxy.stepToRange(th, 0, 0)).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnStep")?.(threadId), 1);
      });
      when(gdbProxy.stepIn(th)).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnStep")?.(threadId), 1);
      });

      await Promise.all([
        dc.configurationSequence(),
        dc.launch(launchArgsStopEntry),
        dc.assertStoppedLocation("entry", { line: 32 }),
      ]);
      await Promise.all([
        dc.nextRequest({ threadId }),
        dc.assertStoppedLocation("step", { line: 33 }),
      ]);
      return expect(
        Promise.all([
          dc.stepInRequest({ threadId }),
          dc.assertStoppedLocation("step", { line: 37 }),
        ])
      ).resolves.toEqual(anyArray);
    });

    it("should continue and stop", async () => {
      when(gdbProxy.stack(th))
        .thenResolve([
          {
            index: 1,
            segmentId: 0,
            offset: 0,
            pc: 0,
            stackFrameIndex: 0,
          },
        ])
        .thenResolve([
          {
            index: 1,
            segmentId: 0,
            offset: 4,
            pc: 4,
            stackFrameIndex: 0,
          },
        ]);
      when(gdbProxy.continueExecution(th)).thenCall(async () => {
        setTimeout(() => callbacks.get("continueThread")?.(threadId, true), 1);
      });
      when(gdbProxy.pause(th)).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnPause")?.(threadId), 1);
      });

      await Promise.all([
        dc.configurationSequence(),
        dc.launch(launchArgsStopEntry),
        dc.assertStoppedLocation("entry", { line: 32 }),
      ]);
      return expect(
        Promise.all([
          dc.continueRequest({ threadId }),
          dc.pauseRequest({ threadId }),
          dc.assertStoppedLocation("pause", { line: 33 }),
        ])
      ).resolves.toEqual(anyArray);
    });
  });

  describe("stack frame index", () => {
    beforeEach(() => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => {
          callbacks.get("stopOnEntry")?.(threadId);
          callbacks.get("segmentsUpdated")?.([
            { id: 0, address: 10, size: 416 },
          ]);
        }, 1);
      });
      when(gdbProxy.getRegister(anyString(), anything()))
        .thenResolve([0, -1])
        .thenResolve([10, 1]);
      when(gdbProxy.getMemory(10, anyNumber())).thenResolve(
        "0000000000c00b0000f8"
      );

      when(gdbProxy.registers(anything())).thenResolve([
        { name: "d0", value: 1 },
        { name: "a0", value: 10 },
      ]);
      when(gdbProxy.getSegments()).thenReturn([
        { name: "example", id: 0, address: 10, size: 10 },
      ]);
      when(gdbProxy.toRelativeOffset(anyNumber())).thenReturn([-1, 40]);
    });

    it("should retrieve a complex stack", async () => {
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: -1,
          segmentId: 0,
          offset: 0,
          pc: 0,
          stackFrameIndex: 1,
        },
        {
          index: 1,
          segmentId: -1,
          offset: 0,
          pc: 10,
          stackFrameIndex: 0,
        },
      ]);
      when(gdbProxy.registers(anything())).thenResolve([
        { name: "d0", value: 1 },
        { name: "a0", value: 10 },
        { name: "sr", value: 0b1000000000000000 },
        { name: "SR_T1", value: 1 },
        { name: "SR_T0", value: 0 },
      ]);
      when(gdbProxy.isCPUThread(anything())).thenReturn(true);

      await Promise.all([
        dc.configurationSequence(),
        dc.launch(launchArgsStopEntry),
        dc.assertStoppedLocation("entry", { line: 32 }),
      ]);

      const response = await dc.stackTraceRequest({ threadId });
      expect(response.success).toEqual(true);
      expect(response.body.totalFrames).toEqual(2);

      const stackFrames = response.body.stackFrames;
      expect(stackFrames[0].id).toEqual(-1);
      expect(stackFrames[0].line).toEqual(32);
      expect(stackFrames[0].name).toEqual("$0: move.l 4.w,a6");

      const src = stackFrames[0].source;
      expect(src).not.toBeUndefined();
      expect(src?.name).not.toBeUndefined();
      expect(src?.name?.toUpperCase()).toEqual("GENCOP.S");
      const pathToTest = path.join("fixtures", "gencop.s").replace(/\\+/g, "/");
      expect(
        src?.path?.toUpperCase().endsWith(pathToTest.toUpperCase())
      ).toEqual(true);
      expect(stackFrames[1].id).toEqual(1);
      expect(stackFrames[1].line).toEqual(0);
      expect(stackFrames[1].name).toEqual("$a: ori.b	#$0, d0");

      const {
        body: { scopes },
      } = await dc.scopesRequest({ frameId: 0 });
      expect(scopes[0].name).toEqual("Registers");
      expect(scopes[1].name).toEqual("Segments");
      expect(scopes[2].name).toEqual("Symbols");

      const {
        body: { variables },
      } = await dc.variablesRequest({
        variablesReference: scopes[0].variablesReference,
      });
      expect(variables).toHaveLength(3);
      expect(variables[0].name).toEqual("d0");
      expect(variables[0].type).toEqual("register");
      expect(variables[0].value).toEqual("0x00000001");
      expect(variables[0].variablesReference).toEqual(0);
      expect(variables[1].name).toEqual("a0");
      expect(variables[2].name).toEqual("sr");
      expect(variables[2].variablesReference).not.toEqual(0);

      //retrieve the sr values
      const {
        body: { variables: srVariables },
      } = await dc.variablesRequest({
        variablesReference: variables[2].variablesReference,
      });
      expect(srVariables[0].name).toEqual("T1");
      expect(srVariables[0].type).toEqual("register");
      expect(srVariables[0].value).toEqual("1");
      expect(srVariables[0].variablesReference).toEqual(0);
      expect(srVariables[1].name).toEqual("T0");

      const {
        body: { variables: segments },
      } = await dc.variablesRequest({
        variablesReference: scopes[1].variablesReference,
      });
      expect(segments[0].name).toEqual("Segment #0");
      expect(segments[0].type).toEqual("segment");
      expect(segments[0].value).toEqual("0x0000000a {size:10}");
      expect(segments[0].variablesReference).toEqual(0);

      const {
        body: { variables: symbols },
      } = await dc.variablesRequest({
        variablesReference: scopes[2].variablesReference,
      });
      expect(symbols[0].name).toEqual("checkmouse");
      expect(symbols[0].type).toEqual("symbol");
      expect(symbols[0].value).toEqual("0x0000015c");
      expect(symbols[0].variablesReference).toEqual(0);
    });

    it("should retrieve a copper stack", async () => {
      when(gdbProxy.getMemory(22624, 10)).thenResolve("0180056c2c07fffe0180");
      when(gdbProxy.getMemory(14676096, 4)).thenResolve("5850");
      when(gdbProxy.isCopperThread(anything())).thenReturn(true);
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: -1,
          segmentId: 0,
          offset: 0,
          pc: 0,
          stackFrameIndex: 1,
        },
      ]);
      when(gdbProxy.stack(thCop)).thenResolve([
        {
          index: -1,
          segmentId: 0,
          offset: 22624,
          pc: 22624,
          stackFrameIndex: 1,
        },
      ]);

      await Promise.all([
        dc.configurationSequence(),
        dc.launch(launchArgsStopEntry),
        dc.assertStoppedLocation("entry", { line: 32 }),
      ]);

      const response = await dc.stackTraceRequest({ threadId: thCop.getId() });
      expect(response.success).toEqual(true);
      expect(response.body.totalFrames).toEqual(1);

      const stackFrames = response.body.stackFrames;
      expect(stackFrames[0].id).toEqual(-1);
      expect(stackFrames[0].line).toEqual(5);
      expect(stackFrames[0].name).toEqual("$5860: dc.w $0180,$056c");

      const src = stackFrames[0].source;
      expect(src).not.toBeUndefined();
      expect(src?.name).not.toBeUndefined();
      expect(src?.name).toEqual("copper_$5850__500.dbgasm");
    });
  });

  describe("evaluateExpression", () => {
    beforeEach(async () => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => callbacks.get("stopOnEntry")?.(threadId), 1);
        callbacks.get("segmentsUpdated")?.([
          {
            name: "example",
            id: 0,
            address: 10,
            size: 416,
          },
        ]);
      });
      when(gdbProxy.setBreakpoint(anything())).thenResolve();
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: 1,
          segmentId: 0,
          offset: 4,
          pc: 10,
          stackFrameIndex: 0,
        },
      ]);
      when(gdbProxy.getRegister(anyString(), anything())).thenResolve([10, -1]);
      when(gdbProxy.registers(anything())).thenResolve([
        {
          name: "d0",
          value: 1,
        },
        {
          name: "a0",
          value: 10,
        },
      ]);
      when(gdbProxy.setMemory(0, anyString())).thenResolve();
      when(gdbProxy.setMemory(10, anyString())).thenResolve();
      when(gdbProxy.setMemory(11, anyString())).thenResolve();
      when(gdbProxy.getMemory(0, anyNumber())).thenResolve(
        "0000000000c00b0000f8"
      );
      when(gdbProxy.getMemory(10, anyNumber())).thenResolve(
        "aa00000000c00b0000f8"
      );
      when(gdbProxy.getMemory(422, anyNumber())).thenResolve("0000000b");
      when(gdbProxy.getMemory(11, anyNumber())).thenResolve(
        "bb00000000c00b0000f8"
      );
      when(gdbProxy.getMemory(0xdff180, anyNumber())).thenResolve("1234");

      await Promise.all([
        dc.configurationSequence(),
        dc.launch(launchArgsStopEntry),
        dc.assertStoppedLocation("entry", { line: 33 }),
      ]);
    });

    it("should evaluate a memory location", async () => {
      let evaluateResponse = await dc.evaluateRequest({
        expression: "m 0,10",
      });
      expect(evaluateResponse.body.type).toBe("array");
      expect(evaluateResponse.body.result).toBe(
        "00000000 00c00b00 00f8          | .....À...ø"
      );

      // Test variable replacement
      evaluateResponse = await dc.evaluateRequest({
        expression: "m ${a0},10",
      });
      expect(evaluateResponse.body.result).toBe(
        "aa000000 00c00b00 00f8          | ª....À...ø"
      );

      evaluateResponse = await dc.evaluateRequest({
        expression: "m ${copper_list},10",
      });
      expect(evaluateResponse.body.result).toBe(
        "0000000b                            | ...."
      );

      evaluateResponse = await dc.evaluateRequest({
        expression: "m #{copper_list},10",
      });
      expect(evaluateResponse.body.result).toBe(
        "bb000000 00c00b00 00f8          | »....À...ø"
      );

      evaluateResponse = await dc.evaluateRequest({
        expression: "m ${COLOR00},1",
      });
      expect(evaluateResponse.body.result).toBe(
        "1234                            | .4"
      );
    });

    it("should respond to a memory read", async () => {
      const args: DebugProtocol.ReadMemoryArguments = {
        memoryReference: "0",
        count: 10,
      };
      const { body } = await dc.customRequest("readMemory", args);
      expect(body.address).toEqual("0");
      expect(body.data).toEqual("AAAAAADACwAA+A==");
    });

    it("should evaluate a set memory command", async () => {
      let evaluateResponse = await dc.evaluateRequest({
        expression: "M 0=10",
      });
      verify(gdbProxy.setMemory(0, anyString())).once();
      resetCalls(gdbProxy);
      expect(evaluateResponse.body.type).toBe("array");
      expect(evaluateResponse.body.result).toBe(
        "00000000 00c00b00 00f8          | .....À...ø"
      );

      // Test variable replacement
      evaluateResponse = await dc.evaluateRequest({
        expression: "M ${a0}=10",
      });
      verify(gdbProxy.setMemory(10, anyString())).once();
      resetCalls(gdbProxy);
      expect(evaluateResponse.body.result).toBe(
        "aa000000 00c00b00 00f8          | ª....À...ø"
      );

      // TODO
      // evaluateResponse = await dc.evaluateRequest({
      //   expression: "M #{copper_list}=10",
      // });
      // verify(mockedGdbProxy.setMemory(11, anyString())).once();
      // resetCalls(mockedGdbProxy);
      // expect(evaluateResponse.body.result).toBe(
      //   "bb000000 00c00b00 00f8          | »....À...ø"
      // );
    });

    it("should evaluate a memory disassemble", async () => {
      let evaluateResponse = await dc.evaluateRequest({
        expression: "m 0,10,d",
      });
      expect(evaluateResponse.body.type).toBe("array");
      expect(evaluateResponse.body.result).toBe("ori.b     #$0, d0");

      // // Test variable replacement
      // evaluateResponse = await dc.evaluateRequest({
      //   expression: "m ${pc},10,d",
      // });
      // expect(evaluateResponse.body.result).toBe("dc.w $aa00");

      evaluateResponse = await dc.evaluateRequest({
        expression: "m ${copper_list},10,d",
      });
      expect(evaluateResponse.body.result).toBe("ori.b     #$b, d0");
    });
  });

  describe("Set variables", () => {
    beforeEach(async () => {
      when(gdbProxy.load(anything(), anything())).thenCall(async () => {
        setTimeout(() => {
          const cb = callbacks.get("stopOnEntry");
          if (cb) {
            cb(th.getId());
          }
        }, 1);
        callbacks.get("segmentsUpdated")?.([
          {
            name: "example",
            id: 0,
            address: 10,
            size: 416,
          },
        ]);
      });
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: 1,
          segmentId: 0,
          offset: 4,
          pc: 10,
          stackFrameIndex: 0,
        },
      ]);
      when(gdbProxy.getRegister(anyString(), anything())).thenResolve([10, -1]);
      when(gdbProxy.registers(anything())).thenResolve([
        { name: "d0", value: 1 },
        { name: "a0", value: 10 },
      ]);

      await Promise.all([
        dc.configurationSequence(),
        dc.launch(launchArgsStopEntry),
        dc.assertStoppedLocation("entry", { line: 33 }),
      ]);
    });

    it("should set a variable value", async () => {
      const responseScopes: DebugProtocol.ScopesResponse =
        await dc.scopesRequest({ frameId: 0 });
      when(gdbProxy.setRegister(anything(), anything())).thenResolve("af");
      const response = await dc.setVariableRequest({
        name: "example",
        value: "af",
        variablesReference: responseScopes.body.scopes[0].variablesReference,
      });
      expect(response.body.value).toEqual("af");
    });
  });

  describe("setExceptionBreakpoints", () => {
    it("should stop on an exception", async () => {
      when(gdbProxy.load(anything(), anything())).thenCall(() => {
        setTimeout(() => {
          const cb = callbacks.get("stopOnException");
          if (cb) {
            cb(
              {
                code: 8,
                details: "details",
              },
              th.getId()
            );
          }
        }, 1);
        return Promise.resolve();
      });
      when(gdbProxy.setBreakpoint(anything())).thenCall(
        async (brp: GdbBreakpoint) => {
          if (brp.exceptionMask === undefined) {
            brp.verified = true;
            const cb = callbacks.get("breakpointValidated");
            if (cb) {
              cb(brp);
            }
          }
        }
      );
      when(gdbProxy.stack(th)).thenResolve([
        {
          index: 1,
          segmentId: 0,
          offset: 4,
          pc: 10,
          stackFrameIndex: 0,
        },
      ]);
      when(gdbProxy.registers(anything())).thenResolve([
        {
          name: "d0",
          value: 1,
        },
      ]);
      when(gdbProxy.getHaltStatus()).thenResolve([
        {
          registers: new Map(),
          code: 8,
          details: "details",
        },
      ]);

      await Promise.all([
        dc
          .waitForEvent("initialized")
          .then(() => dc.setExceptionBreakpointsRequest({ filters: ["all"] }))
          .then(() => dc.configurationDoneRequest()),

        dc.launch(launchArgs),

        dc.assertStoppedLocation("exception", { line: 33 }),
      ]);

      // Test Breakpoint removal
      when(gdbProxy.removeBreakpoint(anything())).thenResolve();
      const response = await dc.setExceptionBreakpointsRequest({
        filters: [],
      });
      expect(response.success).toBeTruthy();
      const [bp] = capture(gdbProxy.removeBreakpoint).last();
      expect(bp).toEqual({
        breakpointType: GdbBreakpointType.EXCEPTION,
        exceptionMask: BreakpointManager.DEFAULT_EXCEPTION_MASK,
        id: 1,
        verified: false,
        offset: 0,
      });
    });
  });
});
