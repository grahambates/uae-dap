import { DebugVariableResolver } from "./debugVariableResolver";

/**
 * Memory Labels extracted from UAE emulator
 * UAE - The Un*x Amiga Emulator
 * Routines for labelling amiga internals.
 */

export interface MemoryLabel {
  name: string;
  adr: number;
}

export interface CustomData {
  name: string;
  adr: number;
  rw?: number;
  special?: number;
}

export class MemoryLabelsRegistry {
  public static readonly intLabels: MemoryLabel[] = [
    { name: "Reset:SSP", adr: 0x0000 },
    { name: "EXECBASE", adr: 0x0004 },
    { name: "BUS ERROR", adr: 0x0008 },
    { name: "ADR ERROR", adr: 0x000c },
    { name: "ILLEG OPC", adr: 0x0010 },
    { name: "DIV BY 0", adr: 0x0014 },
    { name: "CHK", adr: 0x0018 },
    { name: "TRAPV", adr: 0x001c },
    { name: "PRIVIL VIO", adr: 0x0020 },
    { name: "TRACE", adr: 0x0024 },
    { name: "LINEA EMU", adr: 0x0028 },
    { name: "LINEF EMU", adr: 0x002c },
    { name: "INT Uninit", adr: 0x003c },
    { name: "INT Unjust", adr: 0x0060 },
    { name: "Lvl 1 Int", adr: 0x0064 },
    { name: "Lvl 2 Int", adr: 0x0068 },
    { name: "Lvl 3 Int", adr: 0x006c },
    { name: "Lvl 4 Int", adr: 0x0070 },
    { name: "Lvl 5 Int", adr: 0x0074 },
    { name: "Lvl 6 Int", adr: 0x0078 },
    { name: "NMI", adr: 0x007c },
  ];
  public static readonly trap_labels: MemoryLabel[] = [
    { name: "TRAP 00", adr: 0x0080 },
    { name: "TRAP 01", adr: 0x0084 },
    { name: "TRAP 02", adr: 0x0088 },
    { name: "TRAP 03", adr: 0x008c },
    { name: "TRAP 04", adr: 0x0090 },
    { name: "TRAP 05", adr: 0x0094 },
    { name: "TRAP 06", adr: 0x0098 },
    { name: "TRAP 07", adr: 0x009c },
    { name: "TRAP 08", adr: 0x00a0 },
    { name: "TRAP 09", adr: 0x00a4 },
    { name: "TRAP 10", adr: 0x00a8 },
    { name: "TRAP 11", adr: 0x00ac },
    { name: "TRAP 12", adr: 0x00b0 },
    { name: "TRAP 13", adr: 0x00b4 },
    { name: "TRAP 14", adr: 0x00b8 },
    { name: "TRAP 15", adr: 0x00bc },
  ];
  public static readonly memLabels: MemoryLabel[] = [
    { name: "CIAB PRA", adr: 0xbfd000 },
    { name: "CIAB PRB", adr: 0xbfd100 },
    { name: "CIAB DDRA", adr: 0xbfd200 },
    { name: "CIAB DDRB", adr: 0xbfd300 },
    { name: "CIAB TALO", adr: 0xbfd400 },
    { name: "CIAB TAHI", adr: 0xbfd500 },
    { name: "CIAB TBLO", adr: 0xbfd600 },
    { name: "CIAB TBHI", adr: 0xbfd700 },
    { name: "CIAB TDLO", adr: 0xbfd800 },
    { name: "CIAB TDMD", adr: 0xbfd900 },
    { name: "CIAB TDHI", adr: 0xbfda00 },
    { name: "CIAB SDR", adr: 0xbfdc00 },
    { name: "CIAB ICR", adr: 0xbfdd00 },
    { name: "CIAB CRA", adr: 0xbfde00 },
    { name: "CIAB CRB", adr: 0xbfdf00 },
    { name: "CIAA PRA", adr: 0xbfe001 },
    { name: "CIAA PRB", adr: 0xbfe101 },
    { name: "CIAA DDRA", adr: 0xbfe201 },
    { name: "CIAA DDRB", adr: 0xbfe301 },
    { name: "CIAA TALO", adr: 0xbfe401 },
    { name: "CIAA TAHI", adr: 0xbfe501 },
    { name: "CIAA TBLO", adr: 0xbfe601 },
    { name: "CIAA TBHI", adr: 0xbfe701 },
    { name: "CIAA TDLO", adr: 0xbfe801 },
    { name: "CIAA TDMD", adr: 0xbfe901 },
    { name: "CIAA TDHI", adr: 0xbfea01 },
    { name: "CIAA SDR", adr: 0xbfec01 },
    { name: "CIAA ICR", adr: 0xbfed01 },
    { name: "CIAA CRA", adr: 0xbfee01 },
    { name: "CIAA CRB", adr: 0xbfef01 },
    { name: "CLK S1", adr: 0xdc0000 },
    { name: "CLK S10", adr: 0xdc0004 },
    { name: "CLK MI1", adr: 0xdc0008 },
    { name: "CLK MI10", adr: 0xdc000c },
    { name: "CLK H1", adr: 0xdc0010 },
    { name: "CLK H10", adr: 0xdc0014 },
    { name: "CLK D1", adr: 0xdc0018 },
    { name: "CLK D10", adr: 0xdc001c },
    { name: "CLK MO1", adr: 0xdc0020 },
    { name: "CLK MO10", adr: 0xdc0024 },
    { name: "CLK Y1", adr: 0xdc0028 },
    { name: "CLK Y10", adr: 0xdc002e },
    { name: "CLK WEEK", adr: 0xdc0030 },
    { name: "CLK CD", adr: 0xdc0034 },
    { name: "CLK CE", adr: 0xdc0038 },
    { name: "CLK CF", adr: 0xdc003c },
  ];

  /* This table was generated from the list of AGA chip names in
   * AGA.guide available on aminet. It could well have errors in it. */

  public static readonly customData: CustomData[] = [
    {
      name: "BLTDDAT",
      adr: 0xdff000,
    } /* Blitter dest. early read (dummy address) */,
    {
      name: "DMACONR",
      adr: 0xdff002,
      rw: 1,
    } /* Dma control (and blitter status) read */,
    {
      name: "VPOSR",
      adr: 0xdff004,
      rw: 1,
    } /* Read vert most sig. bits (and frame flop */,
    {
      name: "VHPOSR",
      adr: 0xdff006,
      rw: 1,
    } /* Read vert and horiz position of beam */,
    {
      name: "DSKDATR",
      adr: 0xdff008,
    } /* Disk data early read (dummy address) */,
    {
      name: "JOY0DAT",
      adr: 0xdff00a,
      rw: 1,
    } /* Joystick-mouse 0 data (vert,horiz) */,
    {
      name: "JOT1DAT",
      adr: 0xdff00c,
      rw: 1,
    } /* Joystick-mouse 1 data (vert,horiz) */,
    {
      name: "CLXDAT",
      adr: 0xdff00e,
      rw: 1,
    } /* Collision data reg. (read and clear) */,
    {
      name: "ADKCONR",
      adr: 0xdff010,
      rw: 1,
    } /* Audio,disk control register read */,
    {
      name: "POT0DAT",
      adr: 0xdff012,
      rw: 1,
    } /* Pot counter pair 0 data (vert,horiz) */,
    {
      name: "POT1DAT",
      adr: 0xdff014,
      rw: 1,
    } /* Pot counter pair 1 data (vert,horiz) */,
    {
      name: "POTGOR",
      adr: 0xdff016,
      rw: 1,
    } /* Pot pin data read */,
    {
      name: "SERDATR",
      adr: 0xdff018,
      rw: 1,
    } /* Serial port data and status read */,
    {
      name: "DSKBYTR",
      adr: 0xdff01a,
      rw: 1,
    } /* Disk data byte and status read */,
    {
      name: "INTENAR",
      adr: 0xdff01c,
      rw: 1,
    } /* Interrupt enable bits read */,
    {
      name: "INTREQR",
      adr: 0xdff01e,
      rw: 1,
    } /* Interrupt request bits read */,
    {
      name: "DSKPTH",
      adr: 0xdff020,
      rw: 2,
      special: 1,
    } /* Disk pointer (high 5 bits) */,
    {
      name: "DSKPTL",
      adr: 0xdff022,
      rw: 2,
      special: 2,
    } /* Disk pointer (low 15 bits) */,
    {
      name: "DSKLEN",
      adr: 0xdff024,
      rw: 2,
      special: 0,
    } /* Disk length */,
    { name: "DSKDAT", adr: 0xdff026 } /* Disk DMA data write */,
    { name: "REFPTR", adr: 0xdff028 } /* Refresh pointer */,
    {
      name: "VPOSW",
      adr: 0xdff02a,
      rw: 2,
      special: 0,
    } /* Write vert most sig. bits(and frame flop) */,
    {
      name: "VHPOSW",
      adr: 0xdff02c,
      rw: 2,
      special: 0,
    } /* Write vert and horiz pos of beam */,
    {
      name: "COPCON",
      adr: 0xdff02e,
      rw: 2,
      special: 0,
    } /* Coprocessor control reg (CDANG) */,
    {
      name: "SERDAT",
      adr: 0xdff030,
      rw: 2,
      special: 0,
    } /* Serial port data and stop bits write */,
    {
      name: "SERPER",
      adr: 0xdff032,
      rw: 2,
      special: 0,
    } /* Serial port period and control */,
    {
      name: "POTGO",
      adr: 0xdff034,
      rw: 2,
      special: 0,
    } /* Pot count start,pot pin drive enable data */,
    {
      name: "JOYTEST",
      adr: 0xdff036,
      rw: 2,
      special: 0,
    } /* Write to all 4 joystick-mouse counters at once */,
    {
      name: "STREQU",
      adr: 0xdff038,
      rw: 2,
      special: 0,
    } /* Strobe for horiz sync with VB and EQU */,
    {
      name: "STRVBL",
      adr: 0xdff03a,
      rw: 2,
      special: 0,
    } /* Strobe for horiz sync with VB (vert blank) */,
    {
      name: "STRHOR",
      adr: 0xdff03c,
      rw: 2,
      special: 0,
    } /* Strobe for horiz sync */,
    {
      name: "STRLONG",
      adr: 0xdff03e,
      rw: 2,
      special: 0,
    } /* Strobe for identification of long horiz line */,
    {
      name: "BLTCON0",
      adr: 0xdff040,
      rw: 2,
      special: 0,
    } /* Blitter control reg 0 */,
    {
      name: "BLTCON1",
      adr: 0xdff042,
      rw: 2,
      special: 0,
    } /* Blitter control reg 1 */,
    {
      name: "BLTAFWM",
      adr: 0xdff044,
      rw: 2,
      special: 0,
    } /* Blitter first word mask for source A */,
    {
      name: "BLTALWM",
      adr: 0xdff046,
      rw: 2,
      special: 0,
    } /* Blitter last word mask for source A */,
    {
      name: "BLTCPTH",
      adr: 0xdff048,
      rw: 2,
      special: 1,
    } /* Blitter pointer to source C (high 5 bits) */,
    {
      name: "BLTCPTL",
      adr: 0xdff04a,
      rw: 2,
      special: 2,
    } /* Blitter pointer to source C (low 15 bits) */,
    {
      name: "BLTBPTH",
      adr: 0xdff04c,
      rw: 2,
      special: 1,
    } /* Blitter pointer to source B (high 5 bits) */,
    {
      name: "BLTBPTL",
      adr: 0xdff04e,
      rw: 2,
      special: 2,
    } /* Blitter pointer to source B (low 15 bits) */,
    {
      name: "BLTAPTH",
      adr: 0xdff050,
      rw: 2,
      special: 1,
    } /* Blitter pointer to source A (high 5 bits) */,
    {
      name: "BLTAPTL",
      adr: 0xdff052,
      rw: 2,
      special: 2,
    } /* Blitter pointer to source A (low 15 bits) */,
    {
      name: "BPTDPTH",
      adr: 0xdff054,
      rw: 2,
      special: 1,
    } /* Blitter pointer to destn  D (high 5 bits) */,
    {
      name: "BLTDPTL",
      adr: 0xdff056,
      rw: 2,
      special: 2,
    } /* Blitter pointer to destn  D (low 15 bits) */,
    {
      name: "BLTSIZE",
      adr: 0xdff058,
      rw: 2,
      special: 0,
    } /* Blitter start and size (win/width,height) */,
    {
      name: "BLTCON0L",
      adr: 0xdff05a,
      rw: 2,
      special: 4,
    } /* Blitter control 0 lower 8 bits (minterms) */,
    {
      name: "BLTSIZV",
      adr: 0xdff05c,
      rw: 2,
      special: 4,
    } /* Blitter V size (for 15 bit vert size) */,
    {
      name: "BLTSIZH",
      adr: 0xdff05e,
      rw: 2,
      special: 4,
    } /* Blitter H size & start (for 11 bit H size) */,
    {
      name: "BLTCMOD",
      adr: 0xdff060,
      rw: 2,
      special: 0,
    } /* Blitter modulo for source C */,
    {
      name: "BLTBMOD",
      adr: 0xdff062,
      rw: 2,
      special: 0,
    } /* Blitter modulo for source B */,
    {
      name: "BLTAMOD",
      adr: 0xdff064,
      rw: 2,
      special: 0,
    } /* Blitter modulo for source A */,
    {
      name: "BLTDMOD",
      adr: 0xdff066,
      rw: 2,
      special: 0,
    } /* Blitter modulo for destn  D */,
    { name: "Unknown", adr: 0xdff068 } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff06a } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff06c } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff06e } /* Unknown or Unused */,
    {
      name: "BLTCDAT",
      adr: 0xdff070,
      rw: 2,
      special: 0,
    } /* Blitter source C data reg */,
    {
      name: "BLTBDAT",
      adr: 0xdff072,
      rw: 2,
      special: 0,
    } /* Blitter source B data reg */,
    {
      name: "BLTADAT",
      adr: 0xdff074,
      rw: 2,
      special: 0,
    } /* Blitter source A data reg */,
    {
      name: "BLTDDAT",
      adr: 0xdff076,
      rw: 2,
      special: 0,
    } /* Blitter destination reg */,
    {
      name: "SPRHDAT",
      adr: 0xdff078,
    } /* Ext logic UHRES sprite pointer and data identifier */,
    {
      name: "BPLHDAT",
      adr: 0xdff07a,
    } /* Ext logic UHRES bit plane identifier */,
    {
      name: "LISAID",
      adr: 0xdff07c,
      rw: 1,
      special: 8,
    } /* Chip revision level for Denise/Lisa */,
    {
      name: "DSKSYNC",
      adr: 0xdff07e,
      rw: 2,
    } /* Disk sync pattern reg for disk read */,
    {
      name: "COP1LCH",
      adr: 0xdff080,
      rw: 2,
      special: 1,
    } /* Coprocessor first location reg (high 5 bits) */,
    {
      name: "COP1LCL",
      adr: 0xdff082,
      rw: 2,
      special: 2,
    } /* Coprocessor first location reg (low 15 bits) */,
    {
      name: "COP2LCH",
      adr: 0xdff084,
      rw: 2,
      special: 1,
    } /* Coprocessor second reg (high 5 bits) */,
    {
      name: "COP2LCL",
      adr: 0xdff086,
      rw: 2,
      special: 2,
    } /* Coprocessor second reg (low 15 bits) */,
    {
      name: "COPJMP1",
      adr: 0xdff088,
      rw: 2,
    } /* Coprocessor restart at first location */,
    {
      name: "COPJMP2",
      adr: 0xdff08a,
      rw: 2,
    } /* Coprocessor restart at second location */,
    {
      name: "COPINS",
      adr: 0xdff08c,
    } /* Coprocessor inst fetch identify */,
    {
      name: "DIWSTRT",
      adr: 0xdff08e,
      rw: 2,
    } /* Display window start (upper left vert-hor pos) */,
    {
      name: "DIWSTOP",
      adr: 0xdff090,
      rw: 2,
    } /* Display window stop (lower right vert-hor pos) */,
    {
      name: "DDFSTRT",
      adr: 0xdff092,
      rw: 2,
    } /* Display bit plane data fetch start.hor pos */,
    {
      name: "DDFSTOP",
      adr: 0xdff094,
      rw: 2,
    } /* Display bit plane data fetch stop.hor pos */,
    {
      name: "DMACON",
      adr: 0xdff096,
      rw: 2,
    } /* DMA control write (clear or set) */,
    {
      name: "CLXCON",
      adr: 0xdff098,
      rw: 2,
    } /* Collision control */,
    {
      name: "INTENA",
      adr: 0xdff09a,
      rw: 2,
    } /* Interrupt enable bits (clear or set bits) */,
    {
      name: "INTREQ",
      adr: 0xdff09c,
      rw: 2,
    } /* Interrupt request bits (clear or set bits) */,
    {
      name: "ADKCON",
      adr: 0xdff09e,
      rw: 2,
    } /* Audio,disk,UART,control */,
    {
      name: "AUD0LCH",
      adr: 0xdff0a0,
      rw: 2,
      special: 1,
    } /* Audio channel 0 location (high 5 bits) */,
    {
      name: "AUD0LCL",
      adr: 0xdff0a2,
      rw: 2,
      special: 2,
    } /* Audio channel 0 location (low 15 bits) */,
    {
      name: "AUD0LEN",
      adr: 0xdff0a4,
      rw: 2,
    } /* Audio channel 0 length */,
    {
      name: "AUD0PER",
      adr: 0xdff0a6,
      rw: 2,
    } /* Audio channel 0 period */,
    {
      name: "AUD0VOL",
      adr: 0xdff0a8,
      rw: 2,
    } /* Audio channel 0 volume */,
    {
      name: "AUD0DAT",
      adr: 0xdff0aa,
      rw: 2,
    } /* Audio channel 0 data */,
    { name: "Unknown", adr: 0xdff0ac } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff0ae } /* Unknown or Unused */,
    {
      name: "AUD1LCH",
      adr: 0xdff0b0,
      rw: 2,
      special: 1,
    } /* Audio channel 1 location (high 5 bits) */,
    {
      name: "AUD1LCL",
      adr: 0xdff0b2,
      rw: 2,
      special: 2,
    } /* Audio channel 1 location (low 15 bits) */,
    {
      name: "AUD1LEN",
      adr: 0xdff0b4,
      rw: 2,
    } /* Audio channel 1 length */,
    {
      name: "AUD1PER",
      adr: 0xdff0b6,
      rw: 2,
    } /* Audio channel 1 period */,
    {
      name: "AUD1VOL",
      adr: 0xdff0b8,
      rw: 2,
    } /* Audio channel 1 volume */,
    {
      name: "AUD1DAT",
      adr: 0xdff0ba,
      rw: 2,
    } /* Audio channel 1 data */,
    { name: "Unknown", adr: 0xdff0bc } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff0be } /* Unknown or Unused */,
    {
      name: "AUD2LCH",
      adr: 0xdff0c0,
      rw: 2,
      special: 1,
    } /* Audio channel 2 location (high 5 bits) */,
    {
      name: "AUD2LCL",
      adr: 0xdff0c2,
      rw: 2,
      special: 2,
    } /* Audio channel 2 location (low 15 bits) */,
    {
      name: "AUD2LEN",
      adr: 0xdff0c4,
      rw: 2,
    } /* Audio channel 2 length */,
    {
      name: "AUD2PER",
      adr: 0xdff0c6,
      rw: 2,
    } /* Audio channel 2 period */,
    {
      name: "AUD2VOL",
      adr: 0xdff0c8,
      rw: 2,
    } /* Audio channel 2 volume */,
    {
      name: "AUD2DAT",
      adr: 0xdff0ca,
      rw: 2,
    } /* Audio channel 2 data */,
    { name: "Unknown", adr: 0xdff0cc } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff0ce } /* Unknown or Unused */,
    {
      name: "AUD3LCH",
      adr: 0xdff0d0,
      rw: 2,
      special: 1,
    } /* Audio channel 3 location (high 5 bits) */,
    {
      name: "AUD3LCL",
      adr: 0xdff0d2,
      rw: 2,
      special: 2,
    } /* Audio channel 3 location (low 15 bits) */,
    {
      name: "AUD3LEN",
      adr: 0xdff0d4,
      rw: 2,
    } /* Audio channel 3 length */,
    {
      name: "AUD3PER",
      adr: 0xdff0d6,
      rw: 2,
    } /* Audio channel 3 period */,
    {
      name: "AUD3VOL",
      adr: 0xdff0d8,
      rw: 2,
    } /* Audio channel 3 volume */,
    {
      name: "AUD3DAT",
      adr: 0xdff0da,
      rw: 2,
    } /* Audio channel 3 data */,
    { name: "Unknown", adr: 0xdff0dc } /* Unknown or Unused */,
    { name: "Unknown", adr: 0xdff0de } /* Unknown or Unused */,
    {
      name: "BPL1PTH",
      adr: 0xdff0e0,
      rw: 2,
      special: 1,
    } /* Bit plane pointer 1 (high 5 bits) */,
    {
      name: "BPL1PTL",
      adr: 0xdff0e2,
      rw: 2,
      special: 2,
    } /* Bit plane pointer 1 (low 15 bits) */,
    {
      name: "BPL2PTH",
      adr: 0xdff0e4,
      rw: 2,
      special: 1,
    } /* Bit plane pointer 2 (high 5 bits) */,
    {
      name: "BPL2PTL",
      adr: 0xdff0e6,
      rw: 2,
      special: 2,
    } /* Bit plane pointer 2 (low 15 bits) */,
    {
      name: "BPL3PTH",
      adr: 0xdff0e8,
      rw: 2,
      special: 1,
    } /* Bit plane pointer 3 (high 5 bits) */,
    {
      name: "BPL3PTL",
      adr: 0xdff0ea,
      rw: 2,
      special: 2,
    } /* Bit plane pointer 3 (low 15 bits) */,
    {
      name: "BPL4PTH",
      adr: 0xdff0ec,
      rw: 2,
      special: 1,
    } /* Bit plane pointer 4 (high 5 bits) */,
    {
      name: "BPL4PTL",
      adr: 0xdff0ee,
      rw: 2,
      special: 2,
    } /* Bit plane pointer 4 (low 15 bits) */,
    {
      name: "BPL5PTH",
      adr: 0xdff0f0,
      rw: 2,
      special: 1,
    } /* Bit plane pointer 5 (high 5 bits) */,
    {
      name: "BPL5PTL",
      adr: 0xdff0f2,
      rw: 2,
      special: 2,
    } /* Bit plane pointer 5 (low 15 bits) */,
    {
      name: "BPL6PTH",
      adr: 0xdff0f4,
      rw: 2,
      special: 1 | 8,
    } /* Bit plane pointer 6 (high 5 bits) */,
    {
      name: "BPL6PTL",
      adr: 0xdff0f6,
      rw: 2,
      special: 2 | 8,
    } /* Bit plane pointer 6 (low 15 bits) */,
    {
      name: "BPL7PTH",
      adr: 0xdff0f8,
      rw: 2,
      special: 1 | 8,
    } /* Bit plane pointer 7 (high 5 bits) */,
    {
      name: "BPL7PTL",
      adr: 0xdff0fa,
      rw: 2,
      special: 2 | 8,
    } /* Bit plane pointer 7 (low 15 bits) */,
    {
      name: "BPL8PTH",
      adr: 0xdff0fc,
      rw: 2,
      special: 1 | 8,
    } /* Bit plane pointer 8 (high 5 bits) */,
    {
      name: "BPL8PTL",
      adr: 0xdff0fe,
      rw: 2,
      special: 2 | 8,
    } /* Bit plane pointer 8 (low 15 bits) */,
    {
      name: "BPLCON0",
      adr: 0xdff100,
      rw: 2,
    } /* Bit plane control reg (misc control bits) */,
    {
      name: "BPLCON1",
      adr: 0xdff102,
      rw: 2,
    } /* Bit plane control reg (scroll val PF1,PF2) */,
    {
      name: "BPLCON2",
      adr: 0xdff104,
      rw: 2,
    } /* Bit plane control reg (priority control) */,
    {
      name: "BPLCON3",
      adr: 0xdff106,
      rw: 2 | 8,
    } /* Bit plane control reg (enhanced features) */,
    {
      name: "BPL1MOD",
      adr: 0xdff108,
      rw: 2,
    } /* Bit plane modulo (odd planes,or active- fetch lines if bitplane scan-doubling is enabled */,
    {
      name: "BPL2MOD",
      adr: 0xdff10a,
      rw: 2,
    } /* Bit plane modulo (even planes or inactive- fetch lines if bitplane scan-doubling is enabled */,
    {
      name: "BPLCON4",
      adr: 0xdff10c,
      rw: 2 | 8,
    } /* Bit plane control reg (bitplane and sprite masks) */,
    {
      name: "CLXCON2",
      adr: 0xdff10e,
      rw: 2 | 8,
    } /* Extended collision control reg */,
    {
      name: "BPL1DAT",
      adr: 0xdff110,
      rw: 2,
    } /* Bit plane 1 data (parallel to serial con- vert) */,
    {
      name: "BPL2DAT",
      adr: 0xdff112,
      rw: 2,
    } /* Bit plane 2 data (parallel to serial con- vert) */,
    {
      name: "BPL3DAT",
      adr: 0xdff114,
      rw: 2,
    } /* Bit plane 3 data (parallel to serial con- vert) */,
    {
      name: "BPL4DAT",
      adr: 0xdff116,
      rw: 2,
    } /* Bit plane 4 data (parallel to serial con- vert) */,
    {
      name: "BPL5DAT",
      adr: 0xdff118,
      rw: 2,
    } /* Bit plane 5 data (parallel to serial con- vert) */,
    {
      name: "BPL6DAT",
      adr: 0xdff11a,
      rw: 2,
    } /* Bit plane 6 data (parallel to serial con- vert) */,
    {
      name: "BPL7DAT",
      adr: 0xdff11c,
      rw: 2 | 8,
    } /* Bit plane 7 data (parallel to serial con- vert) */,
    {
      name: "BPL8DAT",
      adr: 0xdff11e,
      rw: 2 | 8,
    } /* Bit plane 8 data (parallel to serial con- vert) */,
    {
      name: "SPR0PTH",
      adr: 0xdff120,
      rw: 2,
      special: 1,
    } /* Sprite 0 pointer (high 5 bits) */,
    {
      name: "SPR0PTL",
      adr: 0xdff122,
      rw: 2,
      special: 2,
    } /* Sprite 0 pointer (low 15 bits) */,
    {
      name: "SPR1PTH",
      adr: 0xdff124,
      rw: 2,
      special: 1,
    } /* Sprite 1 pointer (high 5 bits) */,
    {
      name: "SPR1PTL",
      adr: 0xdff126,
      rw: 2,
      special: 2,
    } /* Sprite 1 pointer (low 15 bits) */,
    {
      name: "SPR2PTH",
      adr: 0xdff128,
      rw: 2,
      special: 1,
    } /* Sprite 2 pointer (high 5 bits) */,
    {
      name: "SPR2PTL",
      adr: 0xdff12a,
      rw: 2,
      special: 2,
    } /* Sprite 2 pointer (low 15 bits) */,
    {
      name: "SPR3PTH",
      adr: 0xdff12c,
      rw: 2,
      special: 1,
    } /* Sprite 3 pointer (high 5 bits) */,
    {
      name: "SPR3PTL",
      adr: 0xdff12e,
      rw: 2,
      special: 2,
    } /* Sprite 3 pointer (low 15 bits) */,
    {
      name: "SPR4PTH",
      adr: 0xdff130,
      rw: 2,
      special: 1,
    } /* Sprite 4 pointer (high 5 bits) */,
    {
      name: "SPR4PTL",
      adr: 0xdff132,
      rw: 2,
      special: 2,
    } /* Sprite 4 pointer (low 15 bits) */,
    {
      name: "SPR5PTH",
      adr: 0xdff134,
      rw: 2,
      special: 1,
    } /* Sprite 5 pointer (high 5 bits) */,
    {
      name: "SPR5PTL",
      adr: 0xdff136,
      rw: 2,
      special: 2,
    } /* Sprite 5 pointer (low 15 bits) */,
    {
      name: "SPR6PTH",
      adr: 0xdff138,
      rw: 2,
      special: 1,
    } /* Sprite 6 pointer (high 5 bits) */,
    {
      name: "SPR6PTL",
      adr: 0xdff13a,
      rw: 2,
      special: 2,
    } /* Sprite 6 pointer (low 15 bits) */,
    {
      name: "SPR7PTH",
      adr: 0xdff13c,
      rw: 2,
      special: 1,
    } /* Sprite 7 pointer (high 5 bits) */,
    {
      name: "SPR7PTL",
      adr: 0xdff13e,
      rw: 2,
      special: 2,
    } /* Sprite 7 pointer (low 15 bits) */,
    {
      name: "SPR0POS",
      adr: 0xdff140,
      rw: 2,
    } /* Sprite 0 vert-horiz start pos data */,
    {
      name: "SPR0CTL",
      adr: 0xdff142,
      rw: 2,
    } /* Sprite 0 position and control data */,
    {
      name: "SPR0DATA",
      adr: 0xdff144,
      rw: 2,
    } /* Sprite 0 image data register A */,
    {
      name: "SPR0DATB",
      adr: 0xdff146,
      rw: 2,
    } /* Sprite 0 image data register B */,
    {
      name: "SPR1POS",
      adr: 0xdff148,
      rw: 2,
    } /* Sprite 1 vert-horiz start pos data */,
    {
      name: "SPR1CTL",
      adr: 0xdff14a,
      rw: 2,
    } /* Sprite 1 position and control data */,
    {
      name: "SPR1DATA",
      adr: 0xdff14c,
      rw: 2,
    } /* Sprite 1 image data register A */,
    {
      name: "SPR1DATB",
      adr: 0xdff14e,
      rw: 2,
    } /* Sprite 1 image data register B */,
    {
      name: "SPR2POS",
      adr: 0xdff150,
      rw: 2,
    } /* Sprite 2 vert-horiz start pos data */,
    {
      name: "SPR2CTL",
      adr: 0xdff152,
      rw: 2,
    } /* Sprite 2 position and control data */,
    {
      name: "SPR2DATA",
      adr: 0xdff154,
      rw: 2,
    } /* Sprite 2 image data register A */,
    {
      name: "SPR2DATB",
      adr: 0xdff156,
      rw: 2,
    } /* Sprite 2 image data register B */,
    {
      name: "SPR3POS",
      adr: 0xdff158,
      rw: 2,
    } /* Sprite 3 vert-horiz start pos data */,
    {
      name: "SPR3CTL",
      adr: 0xdff15a,
      rw: 2,
    } /* Sprite 3 position and control data */,
    {
      name: "SPR3DATA",
      adr: 0xdff15c,
      rw: 2,
    } /* Sprite 3 image data register A */,
    {
      name: "SPR3DATB",
      adr: 0xdff15e,
      rw: 2,
    } /* Sprite 3 image data register B */,
    {
      name: "SPR4POS",
      adr: 0xdff160,
      rw: 2,
    } /* Sprite 4 vert-horiz start pos data */,
    {
      name: "SPR4CTL",
      adr: 0xdff162,
      rw: 2,
    } /* Sprite 4 position and control data */,
    {
      name: "SPR4DATA",
      adr: 0xdff164,
      rw: 2,
    } /* Sprite 4 image data register A */,
    {
      name: "SPR4DATB",
      adr: 0xdff166,
      rw: 2,
    } /* Sprite 4 image data register B */,
    {
      name: "SPR5POS",
      adr: 0xdff168,
      rw: 2,
    } /* Sprite 5 vert-horiz start pos data */,
    {
      name: "SPR5CTL",
      adr: 0xdff16a,
      rw: 2,
    } /* Sprite 5 position and control data */,
    {
      name: "SPR5DATA",
      adr: 0xdff16c,
      rw: 2,
    } /* Sprite 5 image data register A */,
    {
      name: "SPR5DATB",
      adr: 0xdff16e,
      rw: 2,
    } /* Sprite 5 image data register B */,
    {
      name: "SPR6POS",
      adr: 0xdff170,
      rw: 2,
    } /* Sprite 6 vert-horiz start pos data */,
    {
      name: "SPR6CTL",
      adr: 0xdff172,
      rw: 2,
    } /* Sprite 6 position and control data */,
    {
      name: "SPR6DATA",
      adr: 0xdff174,
      rw: 2,
    } /* Sprite 6 image data register A */,
    {
      name: "SPR6DATB",
      adr: 0xdff176,
      rw: 2,
    } /* Sprite 6 image data register B */,
    {
      name: "SPR7POS",
      adr: 0xdff178,
      rw: 2,
    } /* Sprite 7 vert-horiz start pos data */,
    {
      name: "SPR7CTL",
      adr: 0xdff17a,
      rw: 2,
    } /* Sprite 7 position and control data */,
    {
      name: "SPR7DATA",
      adr: 0xdff17c,
      rw: 2,
    } /* Sprite 7 image data register A */,
    {
      name: "SPR7DATB",
      adr: 0xdff17e,
      rw: 2,
    } /* Sprite 7 image data register B */,
    { name: "COLOR00", adr: 0xdff180, rw: 2 } /* Color table 00 */,
    { name: "COLOR01", adr: 0xdff182, rw: 2 } /* Color table 01 */,
    { name: "COLOR02", adr: 0xdff184, rw: 2 } /* Color table 02 */,
    { name: "COLOR03", adr: 0xdff186, rw: 2 } /* Color table 03 */,
    { name: "COLOR04", adr: 0xdff188, rw: 2 } /* Color table 04 */,
    { name: "COLOR05", adr: 0xdff18a, rw: 2 } /* Color table 05 */,
    { name: "COLOR06", adr: 0xdff18c, rw: 2 } /* Color table 06 */,
    { name: "COLOR07", adr: 0xdff18e, rw: 2 } /* Color table 07 */,
    { name: "COLOR08", adr: 0xdff190, rw: 2 } /* Color table 08 */,
    { name: "COLOR09", adr: 0xdff192, rw: 2 } /* Color table 09 */,
    { name: "COLOR10", adr: 0xdff194, rw: 2 } /* Color table 10 */,
    { name: "COLOR11", adr: 0xdff196, rw: 2 } /* Color table 11 */,
    { name: "COLOR12", adr: 0xdff198, rw: 2 } /* Color table 12 */,
    { name: "COLOR13", adr: 0xdff19a, rw: 2 } /* Color table 13 */,
    { name: "COLOR14", adr: 0xdff19c, rw: 2 } /* Color table 14 */,
    { name: "COLOR15", adr: 0xdff19e, rw: 2 } /* Color table 15 */,
    { name: "COLOR16", adr: 0xdff1a0, rw: 2 } /* Color table 16 */,
    { name: "COLOR17", adr: 0xdff1a2, rw: 2 } /* Color table 17 */,
    { name: "COLOR18", adr: 0xdff1a4, rw: 2 } /* Color table 18 */,
    { name: "COLOR19", adr: 0xdff1a6, rw: 2 } /* Color table 19 */,
    { name: "COLOR20", adr: 0xdff1a8, rw: 2 } /* Color table 20 */,
    { name: "COLOR21", adr: 0xdff1aa, rw: 2 } /* Color table 21 */,
    { name: "COLOR22", adr: 0xdff1ac, rw: 2 } /* Color table 22 */,
    { name: "COLOR23", adr: 0xdff1ae, rw: 2 } /* Color table 23 */,
    { name: "COLOR24", adr: 0xdff1b0, rw: 2 } /* Color table 24 */,
    { name: "COLOR25", adr: 0xdff1b2, rw: 2 } /* Color table 25 */,
    { name: "COLOR26", adr: 0xdff1b4, rw: 2 } /* Color table 26 */,
    { name: "COLOR27", adr: 0xdff1b6, rw: 2 } /* Color table 27 */,
    { name: "COLOR28", adr: 0xdff1b8, rw: 2 } /* Color table 28 */,
    { name: "COLOR29", adr: 0xdff1ba, rw: 2 } /* Color table 29 */,
    { name: "COLOR30", adr: 0xdff1bc, rw: 2 } /* Color table 30 */,
    { name: "COLOR31", adr: 0xdff1be, rw: 2 } /* Color table 31 */,
    {
      name: "HTOTAL",
      adr: 0xdff1c0,
      rw: 2 | 4,
    } /* Highest number count in horiz line (VARBEAMEN = 1) */,
    {
      name: "HSSTOP",
      adr: 0xdff1c2,
      rw: 2 | 4,
    } /* Horiz line pos for HSYNC stop */,
    {
      name: "HBSTRT",
      adr: 0xdff1c4,
      rw: 2 | 4,
    } /* Horiz line pos for HBLANK start */,
    {
      name: "HBSTOP",
      adr: 0xdff1c6,
      rw: 2 | 4,
    } /* Horiz line pos for HBLANK stop */,
    {
      name: "VTOTAL",
      adr: 0xdff1c8,
      rw: 2 | 4,
    } /* Highest numbered vertical line (VARBEAMEN = 1) */,
    {
      name: "VSSTOP",
      adr: 0xdff1ca,
      rw: 2 | 4,
    } /* Vert line for VBLANK start */,
    {
      name: "VBSTRT",
      adr: 0xdff1cc,
      rw: 2 | 4,
    } /* Vert line for VBLANK start */,
    {
      name: "VBSTOP",
      adr: 0xdff1ce,
      rw: 2 | 4,
    } /* Vert line for VBLANK stop */,
    {
      name: "SPRHSTRT",
      adr: 0xdff1d0,
    } /* UHRES sprite vertical start */,
    {
      name: "SPRHSTOP",
      adr: 0xdff1d2,
    } /* UHRES sprite vertical stop */,
    {
      name: "BPLHSTRT",
      adr: 0xdff1d4,
    } /* UHRES bit plane vertical stop */,
    {
      name: "BPLHSTOP",
      adr: 0xdff1d6,
    } /* UHRES bit plane vertical stop */,
    {
      name: "HHPOSW",
      adr: 0xdff1d8,
    } /* DUAL mode hires H beam counter write */,
    {
      name: "HHPOSR",
      adr: 0xdff1da,
    } /* DUAL mode hires H beam counter read */,
    {
      name: "BEAMCON0",
      adr: 0xdff1dc,
      rw: 2 | 4,
    } /* Beam counter control register (SHRES,UHRES,PAL) */,
    {
      name: "HSSTRT",
      adr: 0xdff1de,
      rw: 2 | 4,
    } /* Horizontal sync start (VARHSY) */,
    {
      name: "VSSTRT",
      adr: 0xdff1e0,
      rw: 2 | 4,
    } /* Vertical sync start (VARVSY) */,
    {
      name: "HCENTER",
      adr: 0xdff1e2,
      rw: 2 | 4,
    } /* Horizontal pos for vsync on interlace */,
    {
      name: "DIWHIGH",
      adr: 0xdff1e4,
      rw: 2 | 4,
    } /* Display window upper bits for start/stop */,
    { name: "BPLHMOD", adr: 0xdff1e6 } /* UHRES bit plane modulo */,
    {
      name: "SPRHPTH",
      adr: 0xdff1e8,
    } /* UHRES sprite pointer (high 5 bits) */,
    {
      name: "SPRHPTL",
      adr: 0xdff1ea,
    } /* UHRES sprite pointer (low 15 bits) */,
    {
      name: "BPLHPTH",
      adr: 0xdff1ec,
    } /* VRam (UHRES) bitplane pointer (hi 5 bits) */,
    {
      name: "BPLHPTL",
      adr: 0xdff1ee,
    } /* VRam (UHRES) bitplane pointer (lo 15 bits) */,
    {
      name: "RESERVED",
      adr: 0xdff1f0,
    } /* Reserved (forever i guess!) */,
    {
      name: "RESERVED",
      adr: 0xdff1f2,
    } /* Reserved (forever i guess!) */,
    {
      name: "RESERVED",
      adr: 0xdff1f4,
    } /* Reserved (forever i guess!) */,
    {
      name: "RESERVED",
      adr: 0xdff1f6,
    } /* Reserved (forever i guess!) */,
    {
      name: "RESERVED",
      adr: 0xdff1f8,
    } /* Reserved (forever i guess!) */,
    {
      name: "RESERVED",
      adr: 0xdff1fa,
    } /* Reserved (forever i guess!) */,
    {
      name: "FMODE",
      adr: 0xdff1fc,
      rw: 2 | 8,
    } /* Fetch mode register */,
    {
      name: "NO-OP(NULL)",
      adr: 0xdff1fe,
    } /*   Can also indicate last 2 or 3 refresh cycles or the restart of the COPPER after lockup.*/,
  ];

  private static customMap: Map<string, CustomData> | undefined;
  private static customMapByAddr: Map<number, CustomData> | undefined;

  private static prepareCustomMap() {
    if (MemoryLabelsRegistry.customMap === undefined) {
      MemoryLabelsRegistry.customMap = new Map<string, CustomData>();
      MemoryLabelsRegistry.customMapByAddr = new Map<number, CustomData>();
      for (const d of MemoryLabelsRegistry.customData) {
        MemoryLabelsRegistry.customMap.set(d.name, d);
        MemoryLabelsRegistry.customMapByAddr.set(d.adr, d);
      }
    }
  }
  public static getCustomAddress(name: string): number | undefined {
    MemoryLabelsRegistry.prepareCustomMap();
    if (MemoryLabelsRegistry.customMap) {
      let d = MemoryLabelsRegistry.customMap.get(name);
      if (d === undefined) {
        // Maybe a double value - lets try with the high position
        d = MemoryLabelsRegistry.customMap.get(name + "H");
        if (d !== undefined) {
          return d.adr;
        }
      } else {
        return d.adr;
      }
    }
    return undefined;
  }
  public static getCustomName(address: number): string | undefined {
    MemoryLabelsRegistry.prepareCustomMap();
    if (MemoryLabelsRegistry.customMapByAddr) {
      const d = MemoryLabelsRegistry.customMapByAddr.get(address);
      if (d) {
        return d.name;
      }
    }
    return undefined;
  }

  public static async getCopperAddress(
    copperIndex: number,
    variableResolver: DebugVariableResolver
  ): Promise<number> {
    let registerName = "COP1LCH";
    if (copperIndex !== 1) {
      registerName = "COP2LCH";
    }
    const copperHigh = MemoryLabelsRegistry.getCustomAddress(registerName);
    if (copperHigh !== undefined) {
      // Getting the value
      const memory = await variableResolver.getMemory(copperHigh, 4);
      return parseInt(memory, 16);
    } else {
      throw new Error("Copper high address not found");
    }
  }
}
