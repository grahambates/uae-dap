export const helpSummary = `Commands:
    m address[,size=16,wordSize=4,rowSize=4][,ab]  Memory dump     a: ascii, b: bytes (default: both)
    M address=bytes                                Memory set      bytes: unprefixed hexadecimal literal
    d address[,size=16]                            Disassemble
    h command                                      Show detailed help for command
UAE Console:
    Use a '$' prefix to execute commands in the emulator's built-in console debugger
    e.g: $v -3    Enable visual debugger
         $?       Show help
Expressions:
    Expressions use JavaScript-like syntax and can include literals, symbols, registers and memory values.
    They can be evaluated in the console as well as in command args, watch, conditional breakpoints and logpoints.
    Type 'h expressions' for more details.
    @(address[,size=4])                            Unsigned memory value
    @s(address[,size=4])                           Signed memory value
`;

export const commandHelp = {
  expressions: `Expressions use JavaScript-like syntax and can include literals, symbols, registers and memory values.
They can be evaluated in the console as well as in command args, watch, conditional breakpoints and logpoints.

Numeric literals can use either JavaScript or ASM style base prefixes:
    decimal (default), hex (0x or $), octal (0o or @) or binary (ob or %)

Operators:
    Arithmetic: + - / * ** % ++ --
    Bitwise:    & | ~ ^ << >>
    Comparison: < <= > >= == !=
    Logical:    && || !
    Ternary:    ? :

Memory references:
  Allow you to reference values from memory. Reads a numeric value from an address, which can be an expression.
  Unsigned memory value:
    @(address[,size=4])
      size: number of bytes to read
      example: @($100)               Unsigned longword value at address $100
  Signed memory value:
    @s(address[,size=4])
      example: @s(a0,2)              Signed word value at address in register a0
`,
  m: `Memory dump:
Outputs raw data from a memory range to the console, grouped into words and rows.
  m address[,size=16,wordSize=4,rowSize=4][,ab]

    address:  starting address to read from
    size:     total bytes to read (default: 16)
    wordSize: number of bytes per word (default: 4)
    rowSize:  number of words per line (default: 4)
    output options: (default: all)
      a: show ascii output, b: show bytes output

  examples:
    m $5c50,10              Dump 10 bytes of memory starting at $5c50
    m CList,CListE-CList    Dump data from the address in symbol CList using a derived byte count
    m a0,DATA_SIZE,2,4,a    DATA_SIZE bytes in rows of 4 words from address in a0
`,
  M: `Memory set:
Write literal byte data to a memory location.
  M address=bytes

  address:  starting address to write to
  bytes:    unprefixed hexadecimal literal

examples:
  M $5c50=0ff534          Write 3 byte value to memory address $5c50
  M MyLabel=0ff5          Write 2 byte value to memory at address in symbol MyLabel
`,
  d: `Disassemble memory as CPU instructions
  d address[,size=16]

  address:  starting address to read from
  size:     total bytes to read (default: 16)

example:
  d pc,10                 Disassemble 10 bytes of memory starting at PC
`,
};
