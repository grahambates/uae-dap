/** System Threads numbers (DMA) for FS_UAE */
export enum GdbAmigaSysThreadIdFsUAE {
  AUD0 = 0, // Thread id designating AUDIO 0 interrupt
  AUD1 = 1, // Thread id designating AUDIO 1 interrupt
  AUD2 = 2, // Thread id designating AUDIO 2 interrupt
  AUD3 = 3, // Thread id designating AUDIO 3 interrupt
  DSK = 4, // Thread id designating DISK interrupt
  SPR = 5, // Thread id designating SPRITE interrupt
  BLT = 6, // Thread id designating BLITTER interrupt
  COP = 7, // Thread id designating COPPER interrupt
  BPL = 8, // Thread id designating BIT-PLANE interrupt
  CPU = 0xf, // Thread id designating default cpu execution
}

/** System Threads numbers (DMA) for WinUAE*/
export enum GdbAmigaSysThreadIdWinUAE {
  CPU = 1, // Thread id designating default cpu execution
  COP = 2, // Thread id designating COPPER interrupt
  AUD0 = 3, // Thread id designating AUDIO 0 interrupt
  AUD1 = 4, // Thread id designating AUDIO 1 interrupt
  AUD2 = 5, // Thread id designating AUDIO 2 interrupt
  AUD3 = 6, // Thread id designating AUDIO 3 interrupt
  DSK = 7, // Thread id designating DISK interrupt
  SPR = 8, // Thread id designating SPRITE interrupt
  BLT = 9, // Thread id designating BLITTER interrupt
  BPL = 10, // Thread id designating BIT-PLANE interrupt
}

/** Possible states of the thread */
export enum GdbThreadState {
  STEPPING,
  RUNNING,
}

/** Information for threads in emulator */
export class GdbThread {
  public static readonly DEFAULT_PROCESS_ID = 1;
  private static supportMultiprocess = false;
  private static nextId = 0;
  private id: number;
  private processId: number;
  private threadId: number;
  private state: GdbThreadState;
  public constructor(processId: number, threadId: number) {
    this.id = GdbThread.getNextId();
    this.processId = processId;
    this.threadId = threadId;
    this.state = GdbThreadState.RUNNING;
  }
  public marshall(): string {
    if (GdbThread.supportMultiprocess) {
      return (
        "p" + this.processId.toString(16) + "." + this.threadId.toString(16)
      );
    } else {
      return this.threadId.toString(16);
    }
  }
  public static parse(value: string): GdbThread {
    // Thread id has the form : "p<process id in hex>.<thread id in hex>"
    const pth = value.split(".");
    let pId = GdbThread.DEFAULT_PROCESS_ID;
    let tId = 0;
    if (pth.length > 1) {
      pId = parseInt(pth[0].substring(1), 16);
      tId = parseInt(pth[1], 16);
    } else {
      tId = parseInt(pth[0], 16);
    }
    return new GdbThread(pId, tId);
  }
  /**
   * Constructs the name of a thread
   */
  public getDisplayName(isWinUAE: boolean): string {
    let name: string;
    if (this.processId === GdbThread.DEFAULT_PROCESS_ID) {
      if (isWinUAE) {
        switch (this.threadId) {
          case GdbAmigaSysThreadIdWinUAE.AUD0:
            name = "audio 0";
            break;
          case GdbAmigaSysThreadIdWinUAE.AUD1:
            name = "audio 1";
            break;
          case GdbAmigaSysThreadIdWinUAE.AUD2:
            name = "audio 2";
            break;
          case GdbAmigaSysThreadIdWinUAE.AUD3:
            name = "audio 3";
            break;
          case GdbAmigaSysThreadIdWinUAE.BLT:
            name = "blitter";
            break;
          case GdbAmigaSysThreadIdWinUAE.BPL:
            name = "bit-plane";
            break;
          case GdbAmigaSysThreadIdWinUAE.COP:
            name = "copper";
            break;
          case GdbAmigaSysThreadIdWinUAE.CPU:
            name = "cpu";
            break;
          case GdbAmigaSysThreadIdWinUAE.DSK:
            name = "disk";
            break;
          case GdbAmigaSysThreadIdWinUAE.SPR:
            name = "sprite";
            break;
          default:
            name = this.threadId.toString();
            break;
        }
      } else {
        switch (this.threadId) {
          case GdbAmigaSysThreadIdFsUAE.AUD0:
            name = "audio 0";
            break;
          case GdbAmigaSysThreadIdFsUAE.AUD1:
            name = "audio 1";
            break;
          case GdbAmigaSysThreadIdFsUAE.AUD2:
            name = "audio 2";
            break;
          case GdbAmigaSysThreadIdFsUAE.AUD3:
            name = "audio 3";
            break;
          case GdbAmigaSysThreadIdFsUAE.BLT:
            name = "blitter";
            break;
          case GdbAmigaSysThreadIdFsUAE.BPL:
            name = "bit-plane";
            break;
          case GdbAmigaSysThreadIdFsUAE.COP:
            name = "copper";
            break;
          case GdbAmigaSysThreadIdFsUAE.CPU:
            name = "cpu";
            break;
          case GdbAmigaSysThreadIdFsUAE.DSK:
            name = "disk";
            break;
          case GdbAmigaSysThreadIdFsUAE.SPR:
            name = "sprite";
            break;
          default:
            name = this.threadId.toString();
            break;
        }
      }
    } else {
      if (GdbThread.supportMultiprocess) {
        name = this.processId + "." + this.threadId;
      } else {
        name = this.threadId.toString();
      }
    }
    return name;
  }
  public getProcessId(): number {
    return this.processId;
  }
  public getThreadId(): number {
    return this.threadId;
  }
  public getId(): number {
    return this.id;
  }
  private static getNextId(): number {
    return GdbThread.nextId++;
  }
  public static setSupportMultiprocess(supportMultiprocess: boolean): void {
    GdbThread.supportMultiprocess = supportMultiprocess;
  }
  public setState(state: GdbThreadState): void {
    this.state = state;
  }
  public getState(): GdbThreadState {
    return this.state;
  }
}
