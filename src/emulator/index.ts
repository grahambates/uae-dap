export interface Emulator {
  runProgram(program: string, options?: EmulatorRunOptions): void;
  terminate(): void;
  stackTrace(): Promise<number[]>;
  getCopperPointer(): Promise<number>;
  pause(): Promise<void>;
  continue(): Promise<void>;
  next(): Promise<void>;
  stepOver(): Promise<void>;
  stepOut(): Promise<void>;
  insertBreakpoint(address: number): Promise<void>;
  removeBreakpoint(address: number): Promise<void>;
  clearBreakpoints(): Promise<void>;
  listBreakpoints(): Promise<number[]>;
  setExpectionBreakpoint(mask: number): Promise<void>;
  getSegments(): Promise<Segment[]>;
  getRegisters(): Promise<Registers>;
  setRegister(name: AReg | DReg, value: number): Promise<void>;
  getCustom(): Promise<Record<string, number>>;
  getVectors(): Promise<Vector[]>;
  getCia(): Promise<CIAs>;
  readMemory(address: number, bytes: number): Promise<Buffer>;
  writeMemory(address: number, buffer: Buffer): Promise<void>;
}

export interface EmulatorOptions extends EmulatorRunOptions {
  exe: string;
  args: string[];
  program: string;
  cwd?: string;
}

export interface EmulatorRunOptions {
  stopOnEntry?: boolean;
  stopOnException?: boolean;
}

export type DReg = "D0" | "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";
export type AReg = "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7";
export type FPReg =
  | "FP0"
  | "FP1"
  | "FP2"
  | "FP3"
  | "FP4"
  | "FP5"
  | "FP6"
  | "FP7";

export type SrReg = {
  T: number;
  S: number;
  M: number;
  X: number;
  N: number;
  Z: number;
  V: number;
  C: number;
  IMASK: number;
  STP: number;
};

export type FpSrReg = { N: number; Z: number; I: number; NAN: number };

export type Registers = Record<DReg, number> &
  Record<AReg, number> &
  Partial<Record<FPReg, number>> & {
    SR: SrReg;
    FPSR?: FpSrReg;
    PC: number;
    FPCR: number;
    USP: number;
    ISP: number;
    SFC?: number;
    DFC?: number;
    CACR?: number;
    VBR?: number;
    CAAR?: number;
    MSP?: number;
  };

export interface StopReason {
  breakpoint?: number;
  exception?: number;
  watchpoint?: {
    id: number;
  };
}

export interface Segment {
  start: number;
  length: number;
  end: number;
}

export interface Vector {
  name: string;
  address: number;
  value: number;
}

export interface CIAs {
  A: Record<string, number>;
  B: Record<string, number>;
}
