import {
  CIAs,
  FpSrReg,
  Registers,
  Segment,
  SrReg,
  StopReason,
  Vector,
} from "..";

/**
 * Parse the output from the 'r' command to return a registers object
 */
export function parseRegisters(text: string): Registers {
  const regMatches = [
    ...text.matchAll(/(?<name>\b[A-Z0-9]{2,5}):?\s+(?<value>[A-F0-9]{1,8}\b)/g),
  ];
  const registers: Registers = nameValueMatches(regMatches) as Registers;

  const pcMatch = text.match(/\n([A-F0-9]{8})/);
  if (pcMatch) registers.PC = parseInt(pcMatch[1], 16);

  const srMatches = [
    ...text.matchAll(/(?<!FP.+)(?<name>[A-Z0-9]+)=(?<value>[A-F0-9]+)/g),
  ];
  registers.SR = nameValueMatches(srMatches) as SrReg;

  const fpsrMatches = [
    ...text.matchAll(/(?<=FP.+)(?<name>[A-Z0-9]+)=(?<value>[A-F0-9]+)/g),
  ];
  if (fpsrMatches.length) {
    registers.FPSR = nameValueMatches(fpsrMatches) as FpSrReg;
  }

  return registers;
}

/**
 * Helper to reduce an array of Regex matches with named groups name/value in an object
 */
export function nameValueMatches(
  matches: RegExpMatchArray[]
): Record<string, number> {
  return matches.reduce<Record<string, number>>((acc, m) => {
    if (m.groups) {
      const { name, value } = m.groups;
      acc[name] = parseInt(value, 16);
    }
    return acc;
  }, {});
}

/**
 * Parse the output from the 'e' command to return object of custom reg key/values
 */
export function parseCustom(text: string): Record<string, number> {
  const matches = [
    ...text.matchAll(/(?<name>[A-Z0-9]+)\t(?<value>[A-F0-9]{4})/g),
  ];
  return nameValueMatches(matches);
}

/**
 * Parse the output from the 'i' command to return array of interrupt/trap vectors
 */
export function parseVectors(text: string): Vector[] {
  const matches = text.matchAll(
    /\$(?<address>[A-Z0-9]{8}) [0-9]{2}:\s+(?<name>[^$]+) \$(?<value>[A-F0-9]{8})/g
  );
  const out = [];
  for (const match of matches) {
    if (match.groups) {
      const { name, value, address } = match.groups!;
      out.push({
        name,
        address: parseInt(address, 16),
        value: parseInt(value, 16),
      });
    }
  }
  return out.sort((a, b) => a.address - b.address);
}

/**
 * Parse the output from the 'c' command to return CIA A/B values
 */
export function parseCia(text: string): CIAs {
  const lines = text.split(/\n/g);
  const exp = /(?<name>\w+)[ =](?<value>[0-9a-z]+)/gi;
  const matchesA = [...lines[0].matchAll(exp), ...lines[1].matchAll(exp)];
  const matchesB = [...lines[2].matchAll(exp), ...lines[3].matchAll(exp)];
  return {
    A: nameValueMatches(matchesA),
    B: nameValueMatches(matchesB),
  };
}

/**
 * Convert memory dump output into a byte buffer
 *
 * The output is only limited by number rows so might not contain the exact desired number of bytes.
 * We therefore need to pass the byte count as a parameter and stop parsing when we reach this limit.
 */
export function parseMemoryDump(dump: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  // The string matches are words but we want bytes, so get two values from first and second pair of hex characters.
  const wordMatches = dump.matchAll(/\b[0-9A-F]{4}\b/g);
  let i = 0;
  for (const match of wordMatches) {
    buffer[i++] = parseInt(match[0].substring(0, 2), 16);
    if (i >= length) break;
    buffer[i++] = parseInt(match[0].substring(2, 4), 16);
    if (i >= length) break;
  }
  return buffer;
}

/**
 * Determine reason for execution stopping from status text.
 */
export function parseStop(text: string): StopReason {
  // Breakpoint at 00C04EB0
  const breakpointMatch = text.match(/Breakpoint at ([0-9A-F]{8})/);
  if (breakpointMatch) {
    return {
      breakpoint: parseInt(breakpointMatch[1], 16),
    };
  }
  // # Exception 27, PC=00C15AC6
  const exceptionMatch = text.match(/Exception ([0-9]+),/);
  if (exceptionMatch) {
    return {
      exception: parseInt(exceptionMatch[1]),
    };
  }
  // # Memwatch 2: break at 00C7FDC0.W  W  0000000F PC=00C7BFEC CPUDW (000)
  const memwatchMatch = text.match(/Memwatch ([0-9]+):/);
  if (memwatchMatch) {
    return {
      watchpoint: {
        id: parseInt(memwatchMatch[1]),
        // TODO: other props
      },
    };
  }
  return {};
}

/**
 * Parse output from 'Zs' segment list command to return array of segments
 */
export function parseSegList(text: string): Segment[] {
  const matches = text.matchAll(
    /\[([0-9a-f]{8}),([0-9a-f]{8}),([0-9a-f]{8})\]/g
  );
  return [...matches].map((match) => {
    return {
      start: parseInt(match[1], 16),
      length: parseInt(match[2], 16),
      end: parseInt(match[3], 16),
    };
  });
}
