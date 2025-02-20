export interface Section {
  index: number;
  /** Section name */
  name: string;
  /** Fixed address of section */
  address: number;
  /** Number of bytes to allocate */
  allocSize: number;
  /** Symbols defined in this hunk (if exported) */
  symbols: SourceSymbol[];
  /** Offsets of source files / lines (if exported in Line Debug data) */
  lineDebugInfo: DebugInfo[];
  /** Size of code/data binary in this hunk or to allocate in case of BSS */
  dataSize?: number;
  /** code/data binary */
  data?: Buffer;
}

export interface SourceSymbol {
  name: string;
  offset: number;
}

export interface SourceLine {
  line: number;
  offset: number;
}

export interface DebugInfo {
  sourceFilename: string;
  baseOffset: number;
  lines: SourceLine[];
}
