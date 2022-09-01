/** System Threads numbers (DMA) */
export enum ThreadId {
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
export enum ThreadState {
  STEPPING,
  RUNNING,
}

/** Information for threads in emulator */
export class Thread {
  public static readonly DEFAULT_PROCESS_ID = 1;
  private static supportMultiprocess = false;
  private static nextId = 0;
  private id: number;
  private state = ThreadState.RUNNING;

  public constructor(private processId: number, private threadId: number) {
    this.id = Thread.getNextId();
  }

  public marshall(): string {
    if (Thread.supportMultiprocess) {
      return (
        "p" + this.processId.toString(16) + "." + this.threadId.toString(16)
      );
    } else {
      return this.threadId.toString(16);
    }
  }

  public static parse(value: string): Thread {
    // Thread id has the form : "p<process id in hex>.<thread id in hex>"
    const pth = value.split(".");
    let pId = Thread.DEFAULT_PROCESS_ID;
    let tId = 0;
    if (pth.length > 1) {
      pId = parseInt(pth[0].substring(1), 16);
      tId = parseInt(pth[1], 16);
    } else {
      tId = parseInt(pth[0], 16);
    }
    return new Thread(pId, tId);
  }
  /**
   * Constructs the name of a thread
   */
  public getDisplayName(): string {
    let name: string;
    if (this.processId === Thread.DEFAULT_PROCESS_ID) {
      switch (this.threadId) {
        case ThreadId.AUD0:
          name = "audio 0";
          break;
        case ThreadId.AUD1:
          name = "audio 1";
          break;
        case ThreadId.AUD2:
          name = "audio 2";
          break;
        case ThreadId.AUD3:
          name = "audio 3";
          break;
        case ThreadId.BLT:
          name = "blitter";
          break;
        case ThreadId.BPL:
          name = "bit-plane";
          break;
        case ThreadId.COP:
          name = "copper";
          break;
        case ThreadId.CPU:
          name = "cpu";
          break;
        case ThreadId.DSK:
          name = "disk";
          break;
        case ThreadId.SPR:
          name = "sprite";
          break;
        default:
          name = this.threadId.toString();
          break;
      }
    } else {
      if (Thread.supportMultiprocess) {
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
  public setState(state: ThreadState): void {
    this.state = state;
  }
  public getState(): ThreadState {
    return this.state;
  }
  public isCPU(): boolean {
    return this.threadId === ThreadId.CPU;
  }
  public isCopper(): boolean {
    return this.threadId === ThreadId.COP;
  }

  private static getNextId(): number {
    return Thread.nextId++;
  }
  public static setSupportMultiprocess(supportMultiprocess: boolean): void {
    Thread.supportMultiprocess = supportMultiprocess;
  }
}
