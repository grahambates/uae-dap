import * as cp from "child_process";
import * as path from "path";
import { DebugProtocol } from "@vscode/debugprotocol";
import { formatHexadecimal, splitLines } from "../utils/strings";

const wasmPath =
  process.env.NODE_ENV === "test"
    ? path.join(__dirname, "..", "..", "wasm", "cstool")
    : path.join(__dirname, "..", "..", "..", "wasm", "cstool");

/**
 * Disassemble a buffer
 * @param buffer Buffer to disassemble
 */
export async function disassemble(
  buffer: string,
  startAddress = 0
): Promise<DisassembledOutput> {
  const args = ["m68k", buffer];

  const process = cp.fork(wasmPath, args, { stdio: "pipe" });

  let code = "";
  process.stdout?.on("data", (data) => (code += data));
  process.stderr?.on("data", (data) => (code += data));

  return new Promise((resolve, reject) => {
    process.on("exit", () =>
      code.includes("ERROR")
        ? reject(code)
        : resolve(processOutput(code, startAddress))
    );
    process.on("error", () => reject(code));
  });
}

export interface DisassembledOutput {
  instructions: DebugProtocol.DisassembledInstruction[];
  code: string;
}

function processOutput(code: string, startAddress: number): DisassembledOutput {
  const instructions: DebugProtocol.DisassembledInstruction[] = [];

  const lines = splitLines(code);
  let i = 0;
  for (let l of lines) {
    l = l.trim();
    if (l.length > 0) {
      const elms = l.split("  ");
      if (elms.length > 2) {
        const instructionElms = elms[2].split("\t");
        let instruction = elms[2];
        if (instructionElms.length > 1) {
          instruction = instructionElms[0].padEnd(10) + instructionElms[1];
        }
        const offset = parseInt(elms[0], 16);

        instructions.push({
          address: formatHexadecimal(startAddress + offset),
          instruction,
          line: i,
          instructionBytes: elms[1],
          column: 0,
        });
      } else {
        instructions.push({
          address: formatHexadecimal(i),
          instruction: l,
          line: i,
          instructionBytes: l,
          column: 0,
        });
      }
      i++;
    }
  }
  return { instructions, code };
}
