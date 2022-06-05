/**
 * Chunks a string
 * @param str String to chunk
 * @param n Array of check elements
 */
export function chunk(str: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < str.length; i += n) {
    out.push(str.substring(i, i + n));
  }
  return out;
}

/**
 * Converts a byte to a character
 * @param byte byte to convert
 * @return character in string
 */
export function byteToASCII(byte: number): string {
  let asciiContents;
  if (byte < 32 || (byte > 127 && byte < 161) || byte > 255) {
    asciiContents = ".";
  } else {
    asciiContents = String.fromCharCode(byte);
  }
  return asciiContents;
}

/**
 * Converts a string containing hex values to an ascii string
 * @param value string to convert
 * @param chunkSize Size of the chuck of hex values
 * @return ascii string
 */
export function hexStringToASCII(value: string, chunkSize: number): string {
  let asciiContents = "";
  const chunks = chunk(value, chunkSize);
  for (const c of chunks) {
    const i = parseInt(c, 16);
    asciiContents += byteToASCII(i);
  }
  return asciiContents;
}

/**
 * Converts a string containing hex values to an ascii string
 * @param value string to convert
 * @return ascii string
 */
export function hexUTF8StringToUTF8(value: string): string {
  // split input into groups of two
  const hex = value.match(/[\s\S]{2}/g) || [];
  let output = "";
  // build a hex-encoded representation of your string
  const j = hex.length;
  for (let i = 0; i < j; i++) {
    output += "%" + ("0" + hex[i]).slice(-2);
  }
  // decode it using this trick
  output = decodeURIComponent(output);
  return output;
}

/**
 * Converts a int32 in an array of bytes
 * @param num Number to convert
 * @return array of bytes
 */
export function int32ToBytes(num: number): Array<number> {
  return [
    (num & 0xff000000) >> 24,
    (num & 0x00ff0000) >> 16,
    (num & 0x0000ff00) >> 8,
    num & 0x000000ff,
  ];
}

/**
 * Converts a int 32 to an ascii string
 * @param value integer to convert
 * @return ascii string
 */
export function int32ToASCII(value: number): string {
  let asciiContents = "";
  const bytes = int32ToBytes(value);
  for (const i of bytes) {
    asciiContents += byteToASCII(i);
  }
  return asciiContents;
}

/**
 * Converts a string to a string of hex values
 * @param asciiString ascii string to convert
 * @return string of hex values
 */
export function asciiToHex(asciiString: string): string {
  let result = "";
  for (let i = 0; i < asciiString.length; ++i) {
    result += ("00" + asciiString.charCodeAt(i).toString(16)).slice(-2);
  }
  return result;
}

/**
 * Convert a hex string to a byte array
 **/
export function hexToBytes(hex: string): Array<number> {
  const bytes = new Array<number>();
  for (let c = 0; c < hex.length; c += 2) {
    bytes.push(parseInt(hex.substring(c, c + 2), 16));
  }
  return bytes;
}

/**
 * Convert a byte array to a hex string
 **/
export function bytesToHex(bytes: Array<number>): string {
  const hex = Array<string>();
  for (let i = 0; i < bytes.length; i++) {
    const current = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex.push((current >>> 4).toString(16));
    hex.push((current & 0xf).toString(16));
  }
  return hex.join("");
}

/**
 * Convert a hex string to a base64 string
 **/
export function hexToBase64(hexString: string): string {
  // Conversion to bytes
  const buffer = Buffer.from(hexToBytes(hexString));
  return buffer.toString("base64");
}

/**
 * Convert a base64 string to a hex string
 **/
export function base64ToHex(base64String: string): string {
  // Conversion to bytes
  return Buffer.from(base64String, "base64").toString("hex");
}

/**
 * Compare two strings.
 * @param a First string
 * @param b Second string
 * @return <0 if a>b, 0 if a=b, >0 if a<b
 */
export function compareStringsLowerCase(
  a: [string, number],
  b: [string, number]
): number {
  const aL = a[0].toLowerCase();
  const bL = b[0].toLowerCase();
  if (aL > bL) {
    return 1;
  } else if (aL < bL) {
    return -1;
  } else {
    return 0;
  }
}

export function formatHexadecimal(value: number, pad = 8) {
  const prefix = value < 0 ? "-0x" : "0x";
  return prefix + Math.abs(value).toString(16).padStart(pad, "0");
}

export function formatBinary(value: number, pad = 32): string {
  return `0b${value.toString(2).padStart(pad, "0")}`;
}

export function formatAddress(value: number): string {
  return `$${value.toString(16)}`;
}

export function formatDecimal(value: number): string {
  return value.toString(10);
}

export enum NumberFormat {
  BINARY,
  DECIMAL,
  DECIMAL_SIGNED,
  DECIMAL_WORD,
  DECIMAL_WORD_SIGNED,
  DECIMAL_BYTE,
  DECIMAL_BYTE_SIGNED,
  BINARY_WORD,
  BINARY_BYTE,
  HEXADECIMAL,
  HEXADECIMAL_SIGNED,
  HEXADECIMAL_WORD,
  HEXADECIMAL_WORD_SIGNED,
  HEXADECIMAL_BYTE,
  HEXADECIMAL_BYTE_SIGNED,
}

export function formatNumber(
  value: number,
  displayFormat = NumberFormat.DECIMAL
): string {
  switch (displayFormat) {
    // Binary:
    case NumberFormat.BINARY:
      return formatBinary(value);
    case NumberFormat.BINARY_WORD:
      return formatBinary(value & 0xffff, 16);
    case NumberFormat.BINARY_BYTE:
      return formatBinary(value & 0xff, 8);
    // Hex:
    case NumberFormat.HEXADECIMAL:
      return formatHexadecimal(value);
    case NumberFormat.HEXADECIMAL_SIGNED:
      return formatHexadecimal(
        value >= 0x8000000 ? value - 0x100000000 : value
      );
    case NumberFormat.HEXADECIMAL_WORD:
      return formatHexadecimal(value & 0xffff, 4);
    case NumberFormat.HEXADECIMAL_WORD_SIGNED: {
      const v = value & 0xffff;
      return formatHexadecimal(v >= 0x8000 ? v - 0x10000 : v, 4);
    }
    case NumberFormat.HEXADECIMAL_BYTE:
      return formatHexadecimal(value & 0xff, 2);
    case NumberFormat.HEXADECIMAL_BYTE_SIGNED: {
      const v = value & 0xff;
      return formatHexadecimal(v >= 0x80 ? v - 0x100 : v, 2);
    }
    // Decimal:
    case NumberFormat.DECIMAL:
      return formatDecimal(value);
    case NumberFormat.DECIMAL_SIGNED:
      return formatDecimal(value >= 0x8000000 ? value - 0x100000000 : value);
    case NumberFormat.DECIMAL_WORD:
      return formatDecimal(value & 0xffff);
    case NumberFormat.DECIMAL_WORD_SIGNED: {
      const v = value & 0xffff;
      return formatDecimal(v >= 0x8000 ? v - 0x10000 : v);
    }
    case NumberFormat.DECIMAL_BYTE:
      return formatDecimal(value & 0xff);
    case NumberFormat.DECIMAL_BYTE_SIGNED: {
      const v = value & 0xff;
      return formatDecimal(v >= 0x80 ? v - 0x100 : v);
    }
    default:
      return formatDecimal(value);
  }
}

export function splitLines(value: string): string[] {
  return value.split(/\r?\n/g);
}

export function bitValue(num: number, hi: number, lo = hi): number {
  const mask = (((-1 << (hi - lo + 1)) ^ -1) << lo) >>> 0;
  return (num & mask) >> lo;
}

/**
 * String replace with async callback
 */
export async function replaceAsync(
  str: string,
  regex: RegExp,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asyncFn: (match: string, ...args: any[]) => Promise<string>
) {
  const promises: Promise<string>[] = [];
  str.replace(regex, (match, ...args) => {
    const promise = asyncFn(match, ...args);
    promises.push(promise);
    return match;
  });
  const data = await Promise.all(promises);
  return str.replace(regex, () => data.shift() as string);
}
