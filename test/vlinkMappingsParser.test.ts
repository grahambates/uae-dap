import * as Path from "path";
import { Hunk } from "../src/amigaHunkParser";
import { parseVlinkMappingsFile } from "../src/vlinkMappingsParser";
const FIXTURES_PATH = Path.join(__dirname, "fixtures");

describe("parseVlinkMappingsFile", function () {
  let hunks: Hunk[] = [];

  describe("Amiga program", () => {
    beforeAll(async () => {
      hunks = await parseVlinkMappingsFile(
        FIXTURES_PATH + "/vlinkMappings.txt"
      );
    });

    it("includes hunks", async function () {
      expect(hunks).toHaveLength(4);
    });

    it("handles size for regular hunks", async function () {
      expect(hunks[0].dataSize).toBe(0x00019a14);
      expect(hunks[0].allocSize).toBe(0x00019a14);
    });

    it("handles size for bss hunks", async function () {
      expect(hunks[2].dataSize).toBe(0);
      expect(hunks[2].allocSize).toBe(0x4e18);
    });

    it("sets memory type from suffix", async function () {
      expect(hunks[0].memType).toBe("ANY");
      expect(hunks[1].memType).toBe("CHIP");
      expect(hunks[2].memType).toBe("CHIP");
      expect(hunks[3].memType).toBe("ANY");
    });

    it("includes symbols", async function () {
      expect(hunks[0].symbols).toHaveLength(27);
      expect(hunks[0].symbols[2].name).toBe("WaitEOF");
      expect(hunks[0].symbols[2].offset).toBe(0xa6);
      expect(hunks[1].symbols[2].name).toBe("CopPal");
      expect(hunks[1].symbols[2].offset).toBe(0x2c);
    });

    it("includes debug info", async function () {
      expect(hunks[0].lineDebugInfo).toHaveLength(6);
      expect(hunks[0].lineDebugInfo[0].sourceFilename).toBe(
        "/Users/BatesGW1/projects/metaballs/includes/PhotonsMiniWrapper1.04!.S"
      );
      expect(hunks[0].lineDebugInfo[0].lines).toHaveLength(68);
      expect(hunks[0].lineDebugInfo[0].lines[0].offset).toBe(0);
      expect(hunks[0].lineDebugInfo[0].lines[0].line).toBe(4);
      expect(hunks[0].lineDebugInfo[0].lines[1].offset).toBe(4);
      expect(hunks[0].lineDebugInfo[0].lines[1].line).toBe(5);

      expect(hunks[1].lineDebugInfo).toHaveLength(1);
      expect(hunks[0].lineDebugInfo[1].sourceFilename).toBe(
        "/Users/BatesGW1/projects/metaballs/main.asm"
      );
    });
  });

  describe("Neo Geo program", () => {
    beforeAll(async () => {
      hunks = await parseVlinkMappingsFile(
        FIXTURES_PATH + "/vlinkMappingsNG.txt"
      );
    });

    it("includes hunks", async function () {
      expect(hunks).toHaveLength(3);
    });

    it("sets sizes", async function () {
      expect(hunks[0].dataSize).toBe(0x00027068);
      expect(hunks[0].allocSize).toBe(0x00027068);
      expect(hunks[2].dataSize).toBe(0xc440);
      expect(hunks[2].allocSize).toBe(0xc440);
    });

    it("includes symbols", async function () {
      expect(hunks[0].symbols).toHaveLength(5569);
      expect(hunks[0].symbols[2].name).toBe("SoftDIPS");
      expect(hunks[0].symbols[2].offset).toBe(0x21e);
      expect(hunks[1].symbols[2].name).toBe("aInsertMoreCoin");
      expect(hunks[1].symbols[2].offset).toBe(0xf);
    });

    it("includes debug info", async function () {
      expect(hunks[0].lineDebugInfo).toHaveLength(479);
      expect(hunks[0].lineDebugInfo[0].sourceFilename).toBe(
        "C:\\Users\\Bigmama\\repos\\tte\\NeoAxe\\header.asm"
      );
      expect(hunks[0].lineDebugInfo[0].lines[0].offset).toBe(0);
      expect(hunks[0].lineDebugInfo[0].lines[0].line).toBe(1);
      expect(hunks[0].lineDebugInfo[0].lines[1].offset).toBe(4);
      expect(hunks[0].lineDebugInfo[0].lines[1].line).toBe(2);
    });
  });
});
