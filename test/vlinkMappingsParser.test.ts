import * as Path from "path";
import { Section } from "../src/sections";
import { parseVlinkMappingsFile } from "../src/vlinkMappingsParser";
const FIXTURES_PATH = Path.join(__dirname, "fixtures");

describe("parseVlinkMappingsFile", function () {
  let sections: Section[] = [];

  describe("Amiga program", () => {
    beforeAll(async () => {
      sections = await parseVlinkMappingsFile(
        FIXTURES_PATH + "/vlinkMappings.txt"
      );
    });

    it("includes hunks", async function () {
      expect(sections).toHaveLength(4);
    });

    it("handles size for regular sections", async function () {
      expect(sections[0].dataSize).toBe(0x00019a14);
      expect(sections[0].allocSize).toBe(0x00019a14);
    });

    it("handles size for bss sections", async function () {
      expect(sections[2].dataSize).toBe(0);
      expect(sections[2].allocSize).toBe(0x4e18);
    });

    it("includes symbols", async function () {
      expect(sections[0].symbols).toHaveLength(27);
      expect(sections[0].symbols[2].name).toBe("WaitEOF");
      expect(sections[0].symbols[2].offset).toBe(0xa6);
      expect(sections[1].symbols[2].name).toBe("CopPal");
      expect(sections[1].symbols[2].offset).toBe(0x2c);
    });

    it("includes debug info", async function () {
      expect(sections[0].lineDebugInfo).toHaveLength(6);
      expect(sections[0].lineDebugInfo[0].sourceFilename).toBe(
        "/Users/BatesGW1/projects/metaballs/includes/PhotonsMiniWrapper1.04!.S"
      );
      expect(sections[0].lineDebugInfo[0].lines).toHaveLength(68);
      expect(sections[0].lineDebugInfo[0].lines[0].offset).toBe(0);
      expect(sections[0].lineDebugInfo[0].lines[0].line).toBe(4);
      expect(sections[0].lineDebugInfo[0].lines[1].offset).toBe(4);
      expect(sections[0].lineDebugInfo[0].lines[1].line).toBe(5);

      expect(sections[1].lineDebugInfo).toHaveLength(1);
      expect(sections[0].lineDebugInfo[1].sourceFilename).toBe(
        "/Users/BatesGW1/projects/metaballs/main.asm"
      );
    });
  });

  describe("Neo Geo program", () => {
    beforeAll(async () => {
      sections = await parseVlinkMappingsFile(
        FIXTURES_PATH + "/vlinkMappingsNG.txt"
      );
    });

    it("includes sections", async function () {
      expect(sections).toHaveLength(3);
    });

    it("sets sizes", async function () {
      expect(sections[0].dataSize).toBe(0x00027068);
      expect(sections[0].allocSize).toBe(0x00027068);
      expect(sections[2].dataSize).toBe(0xc440);
      expect(sections[2].allocSize).toBe(0xc440);
    });

    it("includes symbols", async function () {
      expect(sections[0].symbols).toHaveLength(5569);
      expect(sections[0].symbols[2].name).toBe("SoftDIPS");
      expect(sections[0].symbols[2].offset).toBe(0x21e);
      expect(sections[1].symbols[2].name).toBe("aInsertMoreCoin");
      expect(sections[1].symbols[2].offset).toBe(0xf);
    });

    it("includes debug info", async function () {
      expect(sections[0].lineDebugInfo).toHaveLength(479);
      expect(sections[0].lineDebugInfo[0].sourceFilename).toBe(
        "C:\\Users\\Bigmama\\repos\\tte\\NeoAxe\\header.asm"
      );
      expect(sections[0].lineDebugInfo[0].lines[0].offset).toBe(0);
      expect(sections[0].lineDebugInfo[0].lines[0].line).toBe(1);
      expect(sections[0].lineDebugInfo[0].lines[1].offset).toBe(4);
      expect(sections[0].lineDebugInfo[0].lines[1].line).toBe(2);
    });
  });
});
