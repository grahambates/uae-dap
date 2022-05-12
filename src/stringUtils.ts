export class StringUtils {
  /**
   * Chunks a string
   * @param str String to chunk
   * @param n Array of check elements
   */
  public static chunk(str: string, n: number): string[] {
    const ret = [];
    const maxCount = str.length - n - 1;
    let i;
    for (i = 0; i < maxCount; i += n) {
      ret.push(str.substring(i, n + i));
    }
    if (str.length - i > 0) {
      ret.push(str.substring(i));
    }
    return ret;
  }

  /**
   * Converts a byte to a character
   * @param byte byte to convert
   * @return character in string
   */
  public static convertByteToASCII(byte: number): string {
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
  public static convertHexStringToASCII(
    value: string,
    chunkSize: number
  ): string {
    let asciiContents = "";
    const chunks = this.chunk(value, chunkSize);
    for (const c of chunks) {
      const i = parseInt(c, 16);
      asciiContents += StringUtils.convertByteToASCII(i);
    }
    return asciiContents;
  }

  /**
   * Converts a string containing hex values to an ascii string
   * @param value string to convert
   * @return ascii string
   */
  public static convertHexUTF8StringToUTF8(value: string): string {
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
  public static toBytesInt32(num: number): Array<number> {
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
  public static convertInt32ToASCII(value: number): string {
    let asciiContents = "";
    const bytes = StringUtils.toBytesInt32(value);
    for (const i of bytes) {
      asciiContents += StringUtils.convertByteToASCII(i);
    }
    return asciiContents;
  }

  /**
   * Converts a string to a string of hex values
   * @param asciiString ascii string to convert
   * @return string of hex values
   */
  public static convertStringToHex(asciiString: string): string {
    let result = "";
    for (let i = 0; i < asciiString.length; ++i) {
      result += ("00" + asciiString.charCodeAt(i).toString(16)).slice(-2);
    }
    return result;
  }

  /**
   * Convert a hex string to a byte array
   **/
  public static hexToBytes(hex: string): Array<number> {
    const bytes = new Array<number>();
    for (let c = 0; c < hex.length; c += 2) {
      bytes.push(parseInt(hex.substr(c, 2), 16));
    }
    return bytes;
  }

  /**
   * Convert a byte array to a hex string
   **/
  public static bytesToHex(bytes: Array<number>): string {
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
  static hexToBase64(hexString: string): string {
    // Conversion to bytes
    const buffer = Buffer.from(StringUtils.hexToBytes(hexString));
    return buffer.toString("base64");
  }

  /**
   * Convert a base64 string to a hex string
   **/
  static base64ToHex(base64String: string): string {
    // Conversion to bytes
    return Buffer.from(base64String, "base64").toString("hex");
  }

  /**
   * Compare two strings.
   * @param a First string
   * @param b Second string
   * @return <0 if a>b, 0 if a=b, >0 if a<b
   */
  static compareStringsLowerCase(
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

  /**
   * Format an address to send to vscode
   * @param address  Address to format
   * @param pad address pad
   * @returns Formatted address
   */
  public static formatAddress(address: number, pad = 8) {
    return "0x" + address.toString(16).padStart(pad, "0");
  }
}
