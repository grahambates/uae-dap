import { areSameSourceFileNames } from "../src/utils/files";

describe("files", () => {
  describe("areSameSourceFileNames", () => {
    it("Should compare filenames", function () {
      expect(areSameSourceFileNames("b", "b")).toBeTruthy();
      expect(areSameSourceFileNames("/b/c", "/b/C")).toBeFalsy();
      expect(areSameSourceFileNames("./c", "/b/c")).toBeTruthy();
    });
  });
});
