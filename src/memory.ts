import { DebugProtocol } from "@vscode/debugprotocol";
import { chunk, hexStringToASCII } from "./strings";

interface MemoryResolver {
  getMemory(address: number, size: number): Promise<string>;
}

export async function getCopperAddress(
  copperIndex: number,
  memoryResolver: MemoryResolver
): Promise<number> {
  let registerName = "COP1LCH";
  if (copperIndex !== 1) {
    registerName = "COP2LCH";
  }
  const copperHigh = getCustomAddress(registerName);
  if (copperHigh !== undefined) {
    // Getting the value
    const memory = await memoryResolver.getMemory(copperHigh, 4);
    return parseInt(memory, 16);
  } else {
    throw new Error("Copper high address not found");
  }
}

export function processOutputFromMemoryDump(
  memory: string,
  startAddress: number,
  mode: string,
  wordLength: number,
  rowLength: number
): [string, Array<DebugProtocol.Variable>] {
  let firstRow = "";
  const variables = new Array<DebugProtocol.Variable>();
  const chunks = chunk(memory.toString(), wordLength * 2);
  let i = 0;
  let rowCount = 0;
  let row = "";
  let nextAddress = startAddress;
  let lineAddress = startAddress;
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
  return [firstRow, variables];
}

/**
 * Memory Labels extracted from UAE emulator
 * UAE - The Un*x Amiga Emulator
 * Routines for labelling amiga internals.
 */

export function getCustomAddress(name: string): number | undefined {
  prepareCustomMap();
  if (customMap) {
    let d = customMap.get(name);
    if (d === undefined) {
      // Maybe a double value - lets try with the high position
      d = customMap.get(name + "H");
      if (d !== undefined) {
        return d.adr;
      }
    } else {
      return d.adr;
    }
  }
  return undefined;
}

export function getCustomName(address: number): string | undefined {
  prepareCustomMap();
  if (customMapByAddr) {
    const d = customMapByAddr.get(address);
    if (d) {
      return d.name;
    }
  }
  return undefined;
}

interface CustomData {
  name: string;
  adr: number;
  rw?: number;
  special?: number;
}

/* This table was generated from the list of AGA chip names in
 * AGA.guide available on aminet. It could well have errors in it. */

const customData: CustomData[] = [
  { name: "BLTDDAT", adr: 0xdff000 },
  { name: "DMACONR", adr: 0xdff002, rw: 1 },
  { name: "VPOSR", adr: 0xdff004, rw: 1 },
  { name: "VHPOSR", adr: 0xdff006, rw: 1 },
  { name: "DSKDATR", adr: 0xdff008 },
  { name: "JOY0DAT", adr: 0xdff00a, rw: 1 },
  { name: "JOT1DAT", adr: 0xdff00c, rw: 1 },
  { name: "CLXDAT", adr: 0xdff00e, rw: 1 },
  { name: "ADKCONR", adr: 0xdff010, rw: 1 },
  { name: "POT0DAT", adr: 0xdff012, rw: 1 },
  { name: "POT1DAT", adr: 0xdff014, rw: 1 },
  { name: "POTGOR", adr: 0xdff016, rw: 1 },
  { name: "SERDATR", adr: 0xdff018, rw: 1 },
  { name: "DSKBYTR", adr: 0xdff01a, rw: 1 },
  { name: "INTENAR", adr: 0xdff01c, rw: 1 },
  { name: "INTREQR", adr: 0xdff01e, rw: 1 },
  { name: "DSKPTH", adr: 0xdff020, rw: 2, special: 1 },
  { name: "DSKPTL", adr: 0xdff022, rw: 2, special: 2 },
  { name: "DSKLEN", adr: 0xdff024, rw: 2, special: 0 },
  { name: "DSKDAT", adr: 0xdff026 },
  { name: "REFPTR", adr: 0xdff028 },
  { name: "VPOSW", adr: 0xdff02a, rw: 2, special: 0 },
  { name: "VHPOSW", adr: 0xdff02c, rw: 2, special: 0 },
  { name: "COPCON", adr: 0xdff02e, rw: 2, special: 0 },
  { name: "SERDAT", adr: 0xdff030, rw: 2, special: 0 },
  { name: "SERPER", adr: 0xdff032, rw: 2, special: 0 },
  { name: "POTGO", adr: 0xdff034, rw: 2, special: 0 },
  { name: "JOYTEST", adr: 0xdff036, rw: 2, special: 0 },
  { name: "STREQU", adr: 0xdff038, rw: 2, special: 0 },
  { name: "STRVBL", adr: 0xdff03a, rw: 2, special: 0 },
  { name: "STRHOR", adr: 0xdff03c, rw: 2, special: 0 },
  { name: "STRLONG", adr: 0xdff03e, rw: 2, special: 0 },
  { name: "BLTCON0", adr: 0xdff040, rw: 2, special: 0 },
  { name: "BLTCON1", adr: 0xdff042, rw: 2, special: 0 },
  { name: "BLTAFWM", adr: 0xdff044, rw: 2, special: 0 },
  { name: "BLTALWM", adr: 0xdff046, rw: 2, special: 0 },
  { name: "BLTCPTH", adr: 0xdff048, rw: 2, special: 1 },
  { name: "BLTCPTL", adr: 0xdff04a, rw: 2, special: 2 },
  { name: "BLTBPTH", adr: 0xdff04c, rw: 2, special: 1 },
  { name: "BLTBPTL", adr: 0xdff04e, rw: 2, special: 2 },
  { name: "BLTAPTH", adr: 0xdff050, rw: 2, special: 1 },
  { name: "BLTAPTL", adr: 0xdff052, rw: 2, special: 2 },
  { name: "BPTDPTH", adr: 0xdff054, rw: 2, special: 1 },
  { name: "BLTDPTL", adr: 0xdff056, rw: 2, special: 2 },
  { name: "BLTSIZE", adr: 0xdff058, rw: 2, special: 0 },
  { name: "BLTCON0L", adr: 0xdff05a, rw: 2, special: 4 },
  { name: "BLTSIZV", adr: 0xdff05c, rw: 2, special: 4 },
  { name: "BLTSIZH", adr: 0xdff05e, rw: 2, special: 4 },
  { name: "BLTCMOD", adr: 0xdff060, rw: 2, special: 0 },
  { name: "BLTBMOD", adr: 0xdff062, rw: 2, special: 0 },
  { name: "BLTAMOD", adr: 0xdff064, rw: 2, special: 0 },
  { name: "BLTDMOD", adr: 0xdff066, rw: 2, special: 0 },
  { name: "Unknown", adr: 0xdff068 },
  { name: "Unknown", adr: 0xdff06a },
  { name: "Unknown", adr: 0xdff06c },
  { name: "Unknown", adr: 0xdff06e },
  { name: "BLTCDAT", adr: 0xdff070, rw: 2, special: 0 },
  { name: "BLTBDAT", adr: 0xdff072, rw: 2, special: 0 },
  { name: "BLTADAT", adr: 0xdff074, rw: 2, special: 0 },
  { name: "BLTDDAT", adr: 0xdff076, rw: 2, special: 0 },
  { name: "SPRHDAT", adr: 0xdff078 },
  { name: "BPLHDAT", adr: 0xdff07a },
  { name: "LISAID", adr: 0xdff07c, rw: 1, special: 8 },
  { name: "DSKSYNC", adr: 0xdff07e, rw: 2 },
  { name: "COP1LCH", adr: 0xdff080, rw: 2, special: 1 },
  { name: "COP1LCL", adr: 0xdff082, rw: 2, special: 2 },
  { name: "COP2LCH", adr: 0xdff084, rw: 2, special: 1 },
  { name: "COP2LCL", adr: 0xdff086, rw: 2, special: 2 },
  { name: "COPJMP1", adr: 0xdff088, rw: 2 },
  { name: "COPJMP2", adr: 0xdff08a, rw: 2 },
  { name: "COPINS", adr: 0xdff08c },
  { name: "DIWSTRT", adr: 0xdff08e, rw: 2 },
  { name: "DIWSTOP", adr: 0xdff090, rw: 2 },
  { name: "DDFSTRT", adr: 0xdff092, rw: 2 },
  { name: "DDFSTOP", adr: 0xdff094, rw: 2 },
  { name: "DMACON", adr: 0xdff096, rw: 2 },
  { name: "CLXCON", adr: 0xdff098, rw: 2 },
  { name: "INTENA", adr: 0xdff09a, rw: 2 },
  { name: "INTREQ", adr: 0xdff09c, rw: 2 },
  { name: "ADKCON", adr: 0xdff09e, rw: 2 },
  { name: "AUD0LCH", adr: 0xdff0a0, rw: 2, special: 1 },
  { name: "AUD0LCL", adr: 0xdff0a2, rw: 2, special: 2 },
  { name: "AUD0LEN", adr: 0xdff0a4, rw: 2 },
  { name: "AUD0PER", adr: 0xdff0a6, rw: 2 },
  { name: "AUD0VOL", adr: 0xdff0a8, rw: 2 },
  { name: "AUD0DAT", adr: 0xdff0aa, rw: 2 },
  { name: "Unknown", adr: 0xdff0ac },
  { name: "Unknown", adr: 0xdff0ae },
  { name: "AUD1LCH", adr: 0xdff0b0, rw: 2, special: 1 },
  { name: "AUD1LCL", adr: 0xdff0b2, rw: 2, special: 2 },
  { name: "AUD1LEN", adr: 0xdff0b4, rw: 2 },
  { name: "AUD1PER", adr: 0xdff0b6, rw: 2 },
  { name: "AUD1VOL", adr: 0xdff0b8, rw: 2 },
  { name: "AUD1DAT", adr: 0xdff0ba, rw: 2 },
  { name: "Unknown", adr: 0xdff0bc },
  { name: "Unknown", adr: 0xdff0be },
  { name: "AUD2LCH", adr: 0xdff0c0, rw: 2, special: 1 },
  { name: "AUD2LCL", adr: 0xdff0c2, rw: 2, special: 2 },
  { name: "AUD2LEN", adr: 0xdff0c4, rw: 2 },
  { name: "AUD2PER", adr: 0xdff0c6, rw: 2 },
  { name: "AUD2VOL", adr: 0xdff0c8, rw: 2 },
  { name: "AUD2DAT", adr: 0xdff0ca, rw: 2 },
  { name: "Unknown", adr: 0xdff0cc },
  { name: "Unknown", adr: 0xdff0ce },
  { name: "AUD3LCH", adr: 0xdff0d0, rw: 2, special: 1 },
  { name: "AUD3LCL", adr: 0xdff0d2, rw: 2, special: 2 },
  { name: "AUD3LEN", adr: 0xdff0d4, rw: 2 },
  { name: "AUD3PER", adr: 0xdff0d6, rw: 2 },
  { name: "AUD3VOL", adr: 0xdff0d8, rw: 2 },
  { name: "AUD3DAT", adr: 0xdff0da, rw: 2 },
  { name: "Unknown", adr: 0xdff0dc },
  { name: "Unknown", adr: 0xdff0de },
  { name: "BPL1PTH", adr: 0xdff0e0, rw: 2, special: 1 },
  { name: "BPL1PTL", adr: 0xdff0e2, rw: 2, special: 2 },
  { name: "BPL2PTH", adr: 0xdff0e4, rw: 2, special: 1 },
  { name: "BPL2PTL", adr: 0xdff0e6, rw: 2, special: 2 },
  { name: "BPL3PTH", adr: 0xdff0e8, rw: 2, special: 1 },
  { name: "BPL3PTL", adr: 0xdff0ea, rw: 2, special: 2 },
  { name: "BPL4PTH", adr: 0xdff0ec, rw: 2, special: 1 },
  { name: "BPL4PTL", adr: 0xdff0ee, rw: 2, special: 2 },
  { name: "BPL5PTH", adr: 0xdff0f0, rw: 2, special: 1 },
  { name: "BPL5PTL", adr: 0xdff0f2, rw: 2, special: 2 },
  { name: "BPL6PTH", adr: 0xdff0f4, rw: 2, special: 1 | 8 },
  { name: "BPL6PTL", adr: 0xdff0f6, rw: 2, special: 2 | 8 },
  { name: "BPL7PTH", adr: 0xdff0f8, rw: 2, special: 1 | 8 },
  { name: "BPL7PTL", adr: 0xdff0fa, rw: 2, special: 2 | 8 },
  { name: "BPL8PTH", adr: 0xdff0fc, rw: 2, special: 1 | 8 },
  { name: "BPL8PTL", adr: 0xdff0fe, rw: 2, special: 2 | 8 },
  { name: "BPLCON0", adr: 0xdff100, rw: 2 },
  { name: "BPLCON1", adr: 0xdff102, rw: 2 },
  { name: "BPLCON2", adr: 0xdff104, rw: 2 },
  { name: "BPLCON3", adr: 0xdff106, rw: 2 | 8 },
  { name: "BPL1MOD", adr: 0xdff108, rw: 2 },
  { name: "BPL2MOD", adr: 0xdff10a, rw: 2 },
  { name: "BPLCON4", adr: 0xdff10c, rw: 2 | 8 },
  { name: "CLXCON2", adr: 0xdff10e, rw: 2 | 8 },
  { name: "BPL1DAT", adr: 0xdff110, rw: 2 },
  { name: "BPL2DAT", adr: 0xdff112, rw: 2 },
  { name: "BPL3DAT", adr: 0xdff114, rw: 2 },
  { name: "BPL4DAT", adr: 0xdff116, rw: 2 },
  { name: "BPL5DAT", adr: 0xdff118, rw: 2 },
  { name: "BPL6DAT", adr: 0xdff11a, rw: 2 },
  { name: "BPL7DAT", adr: 0xdff11c, rw: 2 | 8 },
  { name: "BPL8DAT", adr: 0xdff11e, rw: 2 | 8 },
  { name: "SPR0PTH", adr: 0xdff120, rw: 2, special: 1 },
  { name: "SPR0PTL", adr: 0xdff122, rw: 2, special: 2 },
  { name: "SPR1PTH", adr: 0xdff124, rw: 2, special: 1 },
  { name: "SPR1PTL", adr: 0xdff126, rw: 2, special: 2 },
  { name: "SPR2PTH", adr: 0xdff128, rw: 2, special: 1 },
  { name: "SPR2PTL", adr: 0xdff12a, rw: 2, special: 2 },
  { name: "SPR3PTH", adr: 0xdff12c, rw: 2, special: 1 },
  { name: "SPR3PTL", adr: 0xdff12e, rw: 2, special: 2 },
  { name: "SPR4PTH", adr: 0xdff130, rw: 2, special: 1 },
  { name: "SPR4PTL", adr: 0xdff132, rw: 2, special: 2 },
  { name: "SPR5PTH", adr: 0xdff134, rw: 2, special: 1 },
  { name: "SPR5PTL", adr: 0xdff136, rw: 2, special: 2 },
  { name: "SPR6PTH", adr: 0xdff138, rw: 2, special: 1 },
  { name: "SPR6PTL", adr: 0xdff13a, rw: 2, special: 2 },
  { name: "SPR7PTH", adr: 0xdff13c, rw: 2, special: 1 },
  { name: "SPR7PTL", adr: 0xdff13e, rw: 2, special: 2 },
  { name: "SPR0POS", adr: 0xdff140, rw: 2 },
  { name: "SPR0CTL", adr: 0xdff142, rw: 2 },
  { name: "SPR0DATA", adr: 0xdff144, rw: 2 },
  { name: "SPR0DATB", adr: 0xdff146, rw: 2 },
  { name: "SPR1POS", adr: 0xdff148, rw: 2 },
  { name: "SPR1CTL", adr: 0xdff14a, rw: 2 },
  { name: "SPR1DATA", adr: 0xdff14c, rw: 2 },
  { name: "SPR1DATB", adr: 0xdff14e, rw: 2 },
  { name: "SPR2POS", adr: 0xdff150, rw: 2 },
  { name: "SPR2CTL", adr: 0xdff152, rw: 2 },
  { name: "SPR2DATA", adr: 0xdff154, rw: 2 },
  { name: "SPR2DATB", adr: 0xdff156, rw: 2 },
  { name: "SPR3POS", adr: 0xdff158, rw: 2 },
  { name: "SPR3CTL", adr: 0xdff15a, rw: 2 },
  { name: "SPR3DATA", adr: 0xdff15c, rw: 2 },
  { name: "SPR3DATB", adr: 0xdff15e, rw: 2 },
  { name: "SPR4POS", adr: 0xdff160, rw: 2 },
  { name: "SPR4CTL", adr: 0xdff162, rw: 2 },
  { name: "SPR4DATA", adr: 0xdff164, rw: 2 },
  { name: "SPR4DATB", adr: 0xdff166, rw: 2 },
  { name: "SPR5POS", adr: 0xdff168, rw: 2 },
  { name: "SPR5CTL", adr: 0xdff16a, rw: 2 },
  { name: "SPR5DATA", adr: 0xdff16c, rw: 2 },
  { name: "SPR5DATB", adr: 0xdff16e, rw: 2 },
  { name: "SPR6POS", adr: 0xdff170, rw: 2 },
  { name: "SPR6CTL", adr: 0xdff172, rw: 2 },
  { name: "SPR6DATA", adr: 0xdff174, rw: 2 },
  { name: "SPR6DATB", adr: 0xdff176, rw: 2 },
  { name: "SPR7POS", adr: 0xdff178, rw: 2 },
  { name: "SPR7CTL", adr: 0xdff17a, rw: 2 },
  { name: "SPR7DATA", adr: 0xdff17c, rw: 2 },
  { name: "SPR7DATB", adr: 0xdff17e, rw: 2 },
  { name: "COLOR00", adr: 0xdff180, rw: 2 },
  { name: "COLOR01", adr: 0xdff182, rw: 2 },
  { name: "COLOR02", adr: 0xdff184, rw: 2 },
  { name: "COLOR03", adr: 0xdff186, rw: 2 },
  { name: "COLOR04", adr: 0xdff188, rw: 2 },
  { name: "COLOR05", adr: 0xdff18a, rw: 2 },
  { name: "COLOR06", adr: 0xdff18c, rw: 2 },
  { name: "COLOR07", adr: 0xdff18e, rw: 2 },
  { name: "COLOR08", adr: 0xdff190, rw: 2 },
  { name: "COLOR09", adr: 0xdff192, rw: 2 },
  { name: "COLOR10", adr: 0xdff194, rw: 2 },
  { name: "COLOR11", adr: 0xdff196, rw: 2 },
  { name: "COLOR12", adr: 0xdff198, rw: 2 },
  { name: "COLOR13", adr: 0xdff19a, rw: 2 },
  { name: "COLOR14", adr: 0xdff19c, rw: 2 },
  { name: "COLOR15", adr: 0xdff19e, rw: 2 },
  { name: "COLOR16", adr: 0xdff1a0, rw: 2 },
  { name: "COLOR17", adr: 0xdff1a2, rw: 2 },
  { name: "COLOR18", adr: 0xdff1a4, rw: 2 },
  { name: "COLOR19", adr: 0xdff1a6, rw: 2 },
  { name: "COLOR20", adr: 0xdff1a8, rw: 2 },
  { name: "COLOR21", adr: 0xdff1aa, rw: 2 },
  { name: "COLOR22", adr: 0xdff1ac, rw: 2 },
  { name: "COLOR23", adr: 0xdff1ae, rw: 2 },
  { name: "COLOR24", adr: 0xdff1b0, rw: 2 },
  { name: "COLOR25", adr: 0xdff1b2, rw: 2 },
  { name: "COLOR26", adr: 0xdff1b4, rw: 2 },
  { name: "COLOR27", adr: 0xdff1b6, rw: 2 },
  { name: "COLOR28", adr: 0xdff1b8, rw: 2 },
  { name: "COLOR29", adr: 0xdff1ba, rw: 2 },
  { name: "COLOR30", adr: 0xdff1bc, rw: 2 },
  { name: "COLOR31", adr: 0xdff1be, rw: 2 },
  { name: "HTOTAL", adr: 0xdff1c0, rw: 2 | 4 },
  { name: "HSSTOP", adr: 0xdff1c2, rw: 2 | 4 },
  { name: "HBSTRT", adr: 0xdff1c4, rw: 2 | 4 },
  { name: "HBSTOP", adr: 0xdff1c6, rw: 2 | 4 },
  { name: "VTOTAL", adr: 0xdff1c8, rw: 2 | 4 },
  { name: "VSSTOP", adr: 0xdff1ca, rw: 2 | 4 },
  { name: "VBSTRT", adr: 0xdff1cc, rw: 2 | 4 },
  { name: "VBSTOP", adr: 0xdff1ce, rw: 2 | 4 },
  { name: "SPRHSTRT", adr: 0xdff1d0 },
  { name: "SPRHSTOP", adr: 0xdff1d2 },
  { name: "BPLHSTRT", adr: 0xdff1d4 },
  { name: "BPLHSTOP", adr: 0xdff1d6 },
  { name: "HHPOSW", adr: 0xdff1d8 },
  { name: "HHPOSR", adr: 0xdff1da },
  { name: "BEAMCON0", adr: 0xdff1dc, rw: 2 | 4 },
  { name: "HSSTRT", adr: 0xdff1de, rw: 2 | 4 },
  { name: "VSSTRT", adr: 0xdff1e0, rw: 2 | 4 },
  { name: "HCENTER", adr: 0xdff1e2, rw: 2 | 4 },
  { name: "DIWHIGH", adr: 0xdff1e4, rw: 2 | 4 },
  { name: "BPLHMOD", adr: 0xdff1e6 },
  { name: "SPRHPTH", adr: 0xdff1e8 },
  { name: "SPRHPTL", adr: 0xdff1ea },
  { name: "BPLHPTH", adr: 0xdff1ec },
  { name: "BPLHPTL", adr: 0xdff1ee },
  { name: "RESERVED", adr: 0xdff1f0 },
  { name: "RESERVED", adr: 0xdff1f2 },
  { name: "RESERVED", adr: 0xdff1f4 },
  { name: "RESERVED", adr: 0xdff1f6 },
  { name: "RESERVED", adr: 0xdff1f8 },
  { name: "RESERVED", adr: 0xdff1fa },
  { name: "FMODE", adr: 0xdff1fc, rw: 2 | 8 },
  { name: "NO-OP(NULL)", adr: 0xdff1fe },
];

let customMap: Map<string, CustomData> | undefined;
let customMapByAddr: Map<number, CustomData> | undefined;

function prepareCustomMap() {
  if (customMap === undefined) {
    customMap = new Map<string, CustomData>();
    customMapByAddr = new Map<number, CustomData>();
    for (const d of customData) {
      customMap.set(d.name, d);
      customMapByAddr.set(d.adr, d);
    }
  }
}
