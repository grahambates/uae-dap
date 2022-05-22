import { HunkParser, HunkType } from "../src/amigaHunkParser";
import * as Path from "path";

const FIXTURES_PATH = Path.join(__dirname, "fixtures");

// tslint:disable:no-unused-expression
describe("AmigaHunkFile", function () {
  it("Should open a hunk file", async function () {
    const programFilename = Path.join(FIXTURES_PATH, "fs-uae", "hd0", "gencop");
    const parser = new HunkParser();
    const hunks = await parser.readFile(programFilename);
    expect(hunks.length).toBe(1);
    const hunk = hunks[0];
    expect(hunk.symbols).toBeDefined();
    expect(hunk.symbols).toHaveLength(15);
    expect(hunk.symbols?.[0].name).toBe("init");
    expect(hunk.symbols?.[0].offset).toBe(0);
    expect(hunk.codeData).toBeDefined();
    expect(hunk.lineDebugInfo).toBeDefined();
    expect(hunk.lineDebugInfo).toHaveLength(1);
    const sourceFile = hunk.lineDebugInfo?.[0];
    expect(sourceFile?.lines).toHaveLength(106);
    expect(sourceFile?.name).toBe(
      "c:\\Users\\paulr\\workspace\\amiga\\projects\\vscode-amiga-wks-example\\gencop.s"
    );
  });

  it("Should parse the symbols of a multi hunk file", async function () {
    const programFilename = Path.join(
      FIXTURES_PATH,
      "fs-uae",
      "hd0",
      "tutorial"
    );
    const parser = new HunkParser();
    const hunks = await parser.readFile(programFilename);
    expect(hunks).toHaveLength(3);
    // Code hunk
    let hunk = hunks[0];
    expect(hunk.hunkType).toBe(HunkType.CODE);
    expect(hunk.symbols).toBeDefined();
    expect(hunk.symbols).toHaveLength(13);
    // OSOff and start are at the same offset
    const name = hunk.symbols?.[0].name;
    expect(name === "start" || name === "OSOff").toBeTruthy();
    expect(hunk.symbols?.[0].offset).toBe(0);

    expect(hunk.codeData).toBeDefined();
    expect(hunk.lineDebugInfo).toBeDefined();
    // Data hunk
    hunk = hunks[1];
    expect(hunk.hunkType).toBe(HunkType.DATA);
    expect(hunk.symbols).toBeDefined();
    expect(hunk.symbols).toHaveLength(16);
    expect(hunk.symbols?.[0].name).toBe("Spr");
    expect(hunk.symbols?.[0].offset).toBe(0);

    // Data hunk
    hunk = hunks[2];
    expect(hunk.hunkType).toBe(HunkType.BSS);
    expect(hunk.symbols).toBeDefined();
    expect(hunk.symbols).toHaveLength(1);
    expect(hunk.symbols?.[0].name).toBe("Screen");
    expect(hunk.symbols?.[0].offset).toBe(0);
  });

  it("Should parse the a vbcc generated file", async function () {
    const programFilename = Path.join(
      FIXTURES_PATH,
      "fs-uae",
      "hd0",
      "hello-vbcc"
    );
    const parser = new HunkParser();
    const hunks = await parser.readFile(programFilename);
    expect(hunks).toHaveLength(7);
    // Code hunk
    const hunk = hunks[0];
    expect(hunk.codeData).toBeDefined();
    expect(hunk.lineDebugInfo).toBeDefined();
    expect(hunk.lineDebugInfo).toHaveLength(1);
    const sourceFile = hunk.lineDebugInfo?.[0];
    expect(sourceFile?.lines).toHaveLength(11);
    expect(sourceFile?.name).toBe("hello.c");
  });
});
