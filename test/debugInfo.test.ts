import { DebugInfo } from "../src/debugInfo";
import * as Path from "path";
import { URI as Uri } from "vscode-uri";

const FIXTURES_DIR = Path.join(__dirname, "fixtures");

describe("Debug Info", function () {
  it("Should find the segment address", async function () {
    const programFilename = Path.join(FIXTURES_DIR, "fs-uae", "hd0", "gencop");
    const sourceFilename = Path.join(FIXTURES_DIR, "gencop.s");
    const pathReplacements = new Map<string, string>();
    pathReplacements.set(
      "c:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example",
      FIXTURES_DIR
    );
    const di = new DebugInfo(Uri.file(programFilename), pathReplacements);
    await di.load();
    await expect(di.getAddressSeg(sourceFilename, 32)).resolves.toEqual([0, 0]);
    await expect(di.getAddressSeg(sourceFilename, 33)).resolves.toEqual([0, 4]);
  });

  it("Should resolve the line number", async function () {
    const programFilename = Path.join(FIXTURES_DIR, "fs-uae", "hd0", "gencop");
    const pathReplacements = new Map<string, string>();
    pathReplacements.set(
      "c:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example",
      FIXTURES_DIR
    );
    const di = new DebugInfo(Uri.file(programFilename), pathReplacements);
    await expect(di.load()).resolves.toBe(true);
    await expect(di.resolveFileLine(0, 4)).resolves.toEqual([
      FIXTURES_DIR + Path.sep + "gencop.s",
      33,
      "              clr.l      d0                      ; les registres sont des long - il faut les nettoyer avec un .l",
    ]);
  });

  it("Should return all segments from a file", async function () {
    const programFilename = Path.join(FIXTURES_DIR, "fs-uae", "hd0", "gencop");
    const sourceFilename = Path.join(FIXTURES_DIR, "gencop.s");
    const pathReplacements = new Map<string, string>();
    pathReplacements.set(
      "c:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example",
      FIXTURES_DIR
    );
    const di = new DebugInfo(Uri.file(programFilename), pathReplacements);
    await expect(di.load()).resolves.toBe(true);
    await expect(di.getAllSegmentIds(sourceFilename)).resolves.toEqual([0]);
  });

  it("Should raise an error if the file is not found", async function () {
    const di = new DebugInfo(Uri.file("nothere"));
    await expect(di.load()).resolves.toBe(false);
  });

  it("Should compare filenames", function () {
    const di = new DebugInfo(Uri.file("nothere"));
    // tslint:disable-next-line:no-unused-expression
    expect(di.areSameSourceFileNames("b", "b")).toBeTruthy();
    // tslint:disable-next-line:no-unused-expression
    expect(di.areSameSourceFileNames("/b/c", "/b/C")).toBeFalsy();
    // tslint:disable-next-line:no-unused-expression
    expect(di.areSameSourceFileNames("./c", "/b/c")).toBeTruthy();
  });

  it("Should resolve the line number of a C file", async function () {
    const programFilename = Path.join(
      FIXTURES_DIR,
      "fs-uae",
      "hd0",
      "hello-vbcc"
    );
    const pathReplacements = new Map<string, string>();
    const di = new DebugInfo(Uri.file(programFilename), pathReplacements, [
      FIXTURES_DIR,
    ]);
    await expect(di.load()).resolves.toBe(true);
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
    const pathReplacements = new Map<string, string>();
    const di = new DebugInfo(Uri.file(programFilename), pathReplacements, [
      FIXTURES_DIR,
    ]);
    await di.load();
    await expect(di.getAddressSeg(sourceFilename, 9)).resolves.toEqual([
      0, 986,
    ]);
    // Without path
    await expect(di.getAddressSeg("hello.c", 9)).resolves.toEqual([0, 986]);
  });
});
