import {
  NumberFormat,
  formatNumber,
  hexToBase64,
  bytesToHex,
  asciiToHex,
  int32ToASCII,
  hexUTF8StringToUTF8,
  hexToBytes,
  chunk,
  bitValue,
} from "../../src/utils/strings";

describe("strings", () => {
  describe("chunk", () => {
    it("splits a string into 4 char chunks", () => {
      const hexString = "deadbeef";
      const buffer = chunk(hexString, 4);
      expect(buffer.length).toBe(2);
      expect(buffer[0]).toBe("dead");
      expect(buffer[1]).toBe("beef");
    });

    it("splits a string into 2 char chunks", () => {
      const hexString = "deadbeef";
      const buffer = chunk(hexString, 2);
      expect(buffer.length).toBe(4);
      expect(buffer[0]).toBe("de");
      expect(buffer[1]).toBe("ad");
      expect(buffer[2]).toBe("be");
      expect(buffer[3]).toBe("ef");
    });
  });

  describe("hexToBytes", () => {
    it("Should transform a hex string to an array", () => {
      const hexString = "0a0f";
      const buffer = hexToBytes(hexString);
      expect(buffer.length).toBe(2);
      expect(buffer[0]).toBe(10);
      expect(buffer[1]).toBe(15);
    });
  });

  describe("hexToBase64", () => {
    it("Should transform a hex string to a base64", () => {
      const hexString = "0a0f";
      const buffer = hexToBase64(hexString);
      expect(buffer).toBe("Cg8=");
    });
  });

  describe("bytesToHex", () => {
    it("Should transform an array to a hex string", () => {
      const buffer = [10, 15];
      const str = bytesToHex(buffer);
      expect(str).toBe("0a0f");
    });
  });

  describe("asciiToHex", () => {
    it("Should convert a ascii string to hex buffer", () => {
      const str = "abc";
      expect(asciiToHex(str)).toBe("616263");
    });
  });

  describe("int32ToASCII", () => {
    it("Should convert a number to ascii string", () => {
      expect(int32ToASCII(0x0)).toBe("....");
      expect(int32ToASCII(0x60006162)).toBe("`.ab");
      expect(int32ToASCII(0x6385ff00)).toBe("c.ÿ.");
    });
  });

  describe("hexUTF8StringToUTF8", () => {
    it("Should convert a hex string containing an utf8 string to utf8 string", () => {
      expect(hexUTF8StringToUTF8("C385E282AC")).toBe("Å€");
    });
  });

  describe("formatNumber", () => {
    it("formats as binary", () => {
      const result = formatNumber(1024, NumberFormat.BINARY, 4);
      expect(result).toBe("0b00000000000000000000010000000000");
    });

    it("formats as hexidecimal", () => {
      const result = formatNumber(1024, NumberFormat.HEXADECIMAL, 4);
      expect(result).toBe("0x00000400");
    });

    it("formats as decimal", () => {
      const result = formatNumber(1024, NumberFormat.DECIMAL);
      expect(result).toBe("1024");
    });
  });

  describe("bitValue", () => {
    it("gets a value from specified bit range", () => {
      const result = bitValue(0b0001100, 3, 2);
      expect(result).toBe(3);
    });
  });
});
