import { FileParser } from "../src/parsing/fileParser";
import * as Path from "path";
import { URI as Uri } from "vscode-uri";

const FIXTURES_DIR = Path.join(__dirname, "fixtures");
const pathReplacements = {
  "c:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example":
    FIXTURES_DIR,
};
const programFilename = Path.join(FIXTURES_DIR, "fs-uae", "hd0", "gencop");
const sourceFilename = Path.join(FIXTURES_DIR, "gencop.s");

describe("File parser", function () {
  it("Should find the segment address", async function () {
    const di = new FileParser(Uri.file(programFilename), pathReplacements);
    await di.parse();
    await expect(di.getAddressSeg(sourceFilename, 32)).resolves.toEqual([0, 0]);
    await expect(di.getAddressSeg(sourceFilename, 33)).resolves.toEqual([0, 4]);
  });

  it("Should resolve the line number", async function () {
    const di = new FileParser(Uri.file(programFilename), pathReplacements);
    await expect(di.parse()).resolves.toBe(true);
    await expect(di.resolveFileLine(0, 4)).resolves.toEqual([
      FIXTURES_DIR + Path.sep + "gencop.s",
      33,
      "              clr.l      d0                      ; les registres sont des long - il faut les nettoyer avec un .l",
    ]);
  });

  it("Should raise an error if the file is not found", async function () {
    const di = new FileParser(Uri.file("nothere"));
    await expect(di.parse()).resolves.toBe(false);
  });

  it("Should resolve the line number of a C file", async function () {
    const programFilename = Path.join(
      FIXTURES_DIR,
      "fs-uae",
      "hd0",
      "hello-vbcc"
    );
    const di = new FileParser(Uri.file(programFilename), {}, [FIXTURES_DIR]);
    await expect(di.parse()).resolves.toBe(true);
    await expect(di.resolveFileLine(0, 1024)).resolves.toEqual([
      FIXTURES_DIR + Path.sep + "hello.c",
      9,
      '        printf("10 * %d = %d\\n", i, mul_by_ten(i));',
    ]);
  });

  it("Should find the segment address for a C file", async function () {
    const programFilename = Path.join(
      FIXTURES_DIR,
      "fs-uae",
      "hd0",
      "hello-vbcc"
    );
    const sourceFilename = Path.join(FIXTURES_DIR, "hello.c");
    const di = new FileParser(Uri.file(programFilename), {}, [FIXTURES_DIR]);
    await di.parse();
    await expect(di.getAddressSeg(sourceFilename, 9)).resolves.toEqual([
      0, 986,
    ]);
    // Without path
    await expect(di.getAddressSeg("hello.c", 9)).resolves.toEqual([0, 986]);
  });
});
