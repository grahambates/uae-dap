import { FileInfo } from "../src/fileInfo";
import * as Path from "path";
import { normalize } from "../src/utils/files";

const FIXTURES_DIR = Path.join(__dirname, "fixtures");
const pathReplacements = {
  "c:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example":
    FIXTURES_DIR,
};
const programFilename = Path.join(FIXTURES_DIR, "fs-uae", "hd0", "gencop");
const sourceFilename = Path.join(FIXTURES_DIR, "gencop.s");

describe("File info", function () {
  it("Should find the segment address", async function () {
    const di = await FileInfo.create(programFilename, pathReplacements);
    await expect(di.findLocationForLine(sourceFilename, 32)).resolves.toEqual({
      segmentId: 0,
      offset: 0,
    });
    await expect(di.findLocationForLine(sourceFilename, 33)).resolves.toEqual({
      segmentId: 0,
      offset: 4,
    });
  });

  it("Should resolve the line number", async function () {
    const di = await FileInfo.create(programFilename, pathReplacements);
    await expect(di.findLineAtLocation(0, 4)).resolves.toEqual({
      filename: normalize(FIXTURES_DIR + Path.sep + "gencop.s"),
      lineNumber: 33,
      lineText:
        "              clr.l      d0                      ; les registres sont des long - il faut les nettoyer avec un .l",
    });
  });

  it("Should raise an error if the file is not found", async function () {
    await expect(FileInfo.create("nothere")).rejects.toThrow();
  });

  it("Should resolve the line number of a C file", async function () {
    const programFilename = Path.join(
      FIXTURES_DIR,
      "fs-uae",
      "hd0",
      "hello-vbcc"
    );
    const di = await FileInfo.create(programFilename, {}, [FIXTURES_DIR]);
    await expect(di.findLineAtLocation(0, 1024)).resolves.toEqual({
      filename: normalize(FIXTURES_DIR + Path.sep + "hello.c"),
      lineNumber: 9,
      lineText: '        printf("10 * %d = %d\\n", i, mul_by_ten(i));',
    });
  });

  it("Should find the segment address for a C file", async function () {
    const programFilename = Path.join(
      FIXTURES_DIR,
      "fs-uae",
      "hd0",
      "hello-vbcc"
    );
    const sourceFilename = Path.join(FIXTURES_DIR, "hello.c");
    const di = await FileInfo.create(programFilename, {}, [FIXTURES_DIR]);
    await expect(di.findLocationForLine(sourceFilename, 9)).resolves.toEqual({
      segmentId: 0,
      offset: 986,
    });
    // Without path
    await expect(di.findLocationForLine("hello.c", 9)).resolves.toEqual({
      segmentId: 0,
      offset: 986,
    });
  });
});
