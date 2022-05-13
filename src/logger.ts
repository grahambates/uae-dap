type LogFn = (message?: any, ...optionalParams: any[]) => void;

export interface Logger {
  log: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export class NullLogger implements Logger {
  debug() {
    return null;
  }
  info() {
    return null;
  }
  warn() {
    return null;
  }
  error() {
    return null;
  }
  log() {
    return null;
  }
}
