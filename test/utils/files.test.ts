import { resolve } from "path";
import { findBinDir, findWasmDir } from "../../src/utils/files";

describe("files", () => {
  describe("findWasmDir", () => {
    it("finds the wasm directory", () => {
      return expect(findWasmDir()).toBe(resolve(__dirname + "/../../wasm"));
    });
  });
  describe("findBinDir", () => {
    it("finds the emulator bin directory", () => {
      return expect(findBinDir()).toBe(resolve(__dirname + "/../../bin"));
    });
  });
});
