import { resolve } from "path";
import {
  areSameSourceFileNames,
  exists,
  findWasmDir,
  normalize,
} from "../../src/utils/files";

describe("files", () => {
  describe("areSameSourceFileNames", () => {
    it("returns true for exact same filename", () => {
      expect(areSameSourceFileNames("b", "b")).toBe(true);
    });

    it("returns false for different case", () => {
      expect(areSameSourceFileNames("/b/c", "/b/C")).toBe(false);
    });

    it("returns true for relative vs absolute", () => {
      expect(areSameSourceFileNames("./c", "/b/c")).toBe(true);
    });
  });

  describe("normalize", () => {
    it("converts path separators", () => {
      expect(normalize("\\foo\\bar")).toBe("/foo/bar");
    });

    it("converts drive letter to upper case", () => {
      expect(normalize("c:/foo/bar")).toBe("C:/foo/bar");
    });
  });

  describe("exists", () => {
    it("returns true for a file that exists", () => {
      return expect(exists(__dirname + "/../fixtures/hello.c")).resolves.toBe(
        true
      );
    });

    it("returns false for a file that does not exist", () => {
      return expect(exists(__dirname + "/../fixtures/nope.c")).resolves.toBe(
        false
      );
    });
  });

  describe("findWasmDir", () => {
    it("finds the wasm directory", () => {
      return expect(findWasmDir()).toBe(resolve(__dirname + "/../../wasm"));
    });
  });
});
