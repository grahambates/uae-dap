import { DebugProtocol } from "@vscode/debugprotocol";
import {
  when,
  mock,
  anything,
  instance,
  spy,
  verify,
  resetCalls,
  reset,
} from "@johanblumenberg/ts-mockito";

import { GdbBreakpoint, GdbBreakpointType, GdbProxy } from "../src/gdb";
import { DisassemblyManager } from "../src/disassembly";
import { FileParser } from "../src/parsing/fileParser";
import { BreakpointManager } from "../src/breakpointManager";

describe("Breakpoint Manager", () => {
  const err = new Error("not Good");
  const SOURCE_PATH = "/my/source.s";
  const DIS_NAME = "cop_xx_xx.dbgasm";
  const DIS_PATH = `disassemble://${DIS_NAME}`;

  let bpManager: BreakpointManager;
  let spiedBpManager: BreakpointManager;
  let mockedGdbProxy: GdbProxy;
  let mockedDisassemblyManager: DisassemblyManager;
  let mockedDebugInfo: FileParser;

  beforeEach(() => {
    mockedGdbProxy = mock(GdbProxy);
    when(mockedGdbProxy.isConnected()).thenReturn(true);
    mockedDisassemblyManager = mock(DisassemblyManager);
    mockedDebugInfo = mock(FileParser);
    bpManager = new BreakpointManager(
      instance(mockedGdbProxy),
      instance(mockedDisassemblyManager)
    );
  });

  afterEach(() => {
    reset(mockedGdbProxy);
    reset(mockedDebugInfo);
    reset(mockedDisassemblyManager);
  });

  describe("Spied bpManager", () => {
    beforeEach(() => {
      spiedBpManager = spy(bpManager);
    });

    describe("Source breakpoint", () => {
      const sourceLine = 1;
      const source: DebugProtocol.Source = {
        path: SOURCE_PATH,
      };
      const bp: GdbBreakpoint = {
        id: 1,
        source: source,
        line: sourceLine,
        breakpointType: GdbBreakpointType.SOURCE,
        offset: 0,
        verified: false,
        defaultMessage: "",
      };
      const segId = 1;
      const offset = 2;

      describe("Source existing", () => {
        beforeEach(() => {
          when(
            mockedDebugInfo.getAddressSeg(SOURCE_PATH, sourceLine)
          ).thenResolve([segId, offset]);
        });

        describe("has debug info", () => {
          beforeEach(() => {
            bpManager.setFileParser(instance(mockedDebugInfo));
          });

          it("should add a breakpoint", async () => {
            when(mockedGdbProxy.setBreakpoint(anything())).thenResolve();
            const rBp = await bpManager.setBreakpoint(bp);
            expect(rBp.id).toBe(bp.id);
            expect(rBp.segmentId).toBe(segId);
            expect(rBp.offset).toBe(offset);
          });

          it("should react on proxy error", async () => {
            when(mockedGdbProxy.setBreakpoint(anything())).thenReject(err);
            await expect(bpManager.setBreakpoint(bp)).rejects.toThrowError(err);
            verify(
              spiedBpManager.addPendingBreakpoint(anything(), anything())
            ).once();
          });

          it("should remove the breakpoints", async () => {
            when(mockedGdbProxy.setBreakpoint(anything())).thenResolve();
            await expect(bpManager.setBreakpoint(bp)).resolves.toBeTruthy();
            // error while removing
            when(mockedGdbProxy.removeBreakpoint(anything())).thenReject(err);
            await expect(bpManager.clearBreakpoints(source)).rejects.toThrow();

            resetCalls(mockedGdbProxy);
            when(mockedGdbProxy.removeBreakpoint(anything())).thenResolve();
            // clean on other source
            await expect(
              bpManager.clearBreakpoints({
                path: "/other/source.s",
              })
            ).resolves.toBeUndefined();
            verify(mockedGdbProxy.removeBreakpoint(anything())).never();

            await expect(
              bpManager.clearBreakpoints(source)
            ).resolves.toBeUndefined();
            verify(mockedGdbProxy.removeBreakpoint(anything())).once();
          });
        });

        it("should reject if there is no debug info", async () => {
          await expect(bpManager.setBreakpoint(bp)).rejects.toThrow();
          verify(
            spiedBpManager.addPendingBreakpoint(anything(), anything())
          ).once();
        });
      });

      describe("Segment or offset not resolved", () => {
        beforeEach(() => {
          when(
            mockedDebugInfo.getAddressSeg(SOURCE_PATH, sourceLine)
          ).thenReturn();
        });

        it("should reject if the segment or offset not resolved", async () => {
          await expect(bpManager.setBreakpoint(bp)).rejects.toThrow();
          verify(
            spiedBpManager.addPendingBreakpoint(anything(), anything())
          ).once();
        });
      });
    });

    describe("Address breakpoint", () => {
      const sourceLine = 1;
      const bp = <GdbBreakpoint>{
        id: 1,
        source: {
          name: DIS_NAME,
          path: DIS_PATH,
        },
        line: sourceLine,
      };
      const address = 123;

      describe("Source existing", () => {
        beforeEach(() => {
          when(
            mockedDisassemblyManager.getAddressForFileEditorLine(
              DIS_NAME,
              sourceLine
            )
          ).thenResolve(address);
        });

        it("should add a breakpoint", async () => {
          when(mockedGdbProxy.setBreakpoint(anything())).thenResolve();
          const rBp = await bpManager.setBreakpoint(bp);
          expect(rBp.id).toBe(bp.id);
          // tslint:disable-next-line: no-unused-expression
          expect(rBp.segmentId).toBeUndefined();
          expect(rBp.offset).toBe(address);
        });

        it("should react on proxy error", async () => {
          when(mockedGdbProxy.setBreakpoint(anything())).thenReject(err);
          await expect(bpManager.setBreakpoint(bp)).rejects.toThrowError(err);
          verify(
            spiedBpManager.addPendingBreakpoint(anything(), anything())
          ).once();
        });
      });

      describe("Address not resolved", () => {
        beforeEach(() => {
          when(
            mockedDisassemblyManager.getAddressForFileEditorLine(
              DIS_NAME,
              sourceLine
            )
          ).thenReject(err);
        });

        it("should reject if the segment or offset not resolved", async () => {
          await expect(bpManager.setBreakpoint(bp)).rejects.toThrowError(err);
          verify(
            spiedBpManager.addPendingBreakpoint(anything(), anything())
          ).once();
        });
      });
    });

    it("should reject if the breakpoint is incomplete", async () => {
      const bp = <GdbBreakpoint>{};
      await expect(bpManager.setBreakpoint(bp)).rejects.toThrow();
      verify(
        spiedBpManager.addPendingBreakpoint(anything(), anything())
      ).once();
    });
  });

  it("should send all pending breakpoints", async () => {
    const sourceLine = 1;
    const bp = <GdbBreakpoint>{
      id: 1,
      source: {
        path: SOURCE_PATH,
      },
      line: sourceLine,
    };
    const segId = 1;
    const offset = 2;
    bpManager.setFileParser(instance(mockedDebugInfo));
    when(mockedDebugInfo.getAddressSeg(SOURCE_PATH, sourceLine)).thenResolve([
      segId,
      offset,
    ]);
    when(mockedGdbProxy.setBreakpoint(anything())).thenReject(err);
    bpManager.addPendingBreakpoint(bp);
    expect(bpManager.getPendingBreakpoints()).toHaveLength(1);
    await expect(
      bpManager.sendAllPendingBreakpoints()
    ).resolves.toBeUndefined();
    expect(bpManager.getPendingBreakpoints()).toHaveLength(1);

    // case ok
    when(mockedGdbProxy.setBreakpoint(anything())).thenResolve();
    await expect(
      bpManager.sendAllPendingBreakpoints()
    ).resolves.toBeUndefined();
    expect(bpManager.getPendingBreakpoints()).toHaveLength(0);
  });
});
