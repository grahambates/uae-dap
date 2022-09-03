export class Mutex {
  private storage = new Map<string, number>();

  public constructor(
    private intervalMs: number,
    private autoUnlockTimeoutMs: number
  ) {}

  public capture(key: string): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      this.checkMutexAndLock(key, resolve, reject);
    });
  }

  private checkMutexAndLock(
    key: string,
    resolve: (value: (() => void) | PromiseLike<() => void>) => void,
    reject: (value: (() => void) | PromiseLike<() => void>) => void
  ) {
    if (!this.storage.has(key)) {
      const value_1 = Date.now();
      this.storage.set(key, value_1);
      const timeout_1 = setTimeout(async () => {
        this.storage.delete(key);
      }, this.autoUnlockTimeoutMs);
      resolve(() => {
        clearTimeout(timeout_1);
        if (this.storage.get(key) === value_1) {
          this.storage.delete(key);
        }
      });
    } else {
      setTimeout(
        this.checkMutexAndLock.bind(this, key, resolve, reject),
        this.intervalMs
      );
    }
  }
}
