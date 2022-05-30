import { Mutex } from "../../src/utils/mutex";

describe("Mutex", () => {
  describe("capture", () => {
    it("blocks until lock is released", async () => {
      const actions = [];
      const inst = new Mutex(10, 100);
      const release = await inst.capture("foo");
      const promise = inst.capture("foo").then((release) => {
        actions.push("b");
        release();
      });
      actions.push("a");
      release();
      await promise;
      expect(actions).toEqual(["a", "b"]);
    });

    it("issues separate locks for different keys", async () => {
      const actions = [];
      const inst = new Mutex(10, 100);
      const release = await inst.capture("foo");
      await inst.capture("bar").then((release) => {
        actions.push("b");
        release();
      });
      actions.push("a");
      release();
      expect(actions).toEqual(["b", "a"]);
    });
  });
});
