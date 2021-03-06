import * as cp from "child_process";
import * as path from "path";
import { DebugProtocol } from "@vscode/debugprotocol";
import { formatHexadecimal, splitLines } from "../utils/strings";
import { findWasmDir } from "../utils/files";

/**
 * Disassemble a buffer into CPU instructions
 */
export async function disassemble(
  buffer: string,
  startAddress = 0
): Promise<DisassembledOutput> {
  const args = ["m68k", buffer];

  const wasmPath = path.join(findWasmDir(), "cstool");
  const proc = cp.fork(wasmPath, args, {
    stdio: "pipe",
    // Prevent the child process from also being started in inspect mode
    // See https://github.com/nodejs/node/issues/14325
    execArgv: [],
  });

  let code = "";
  proc.stdout?.on("data", (data) => (code += data));
  proc.stderr?.on("data", (data) => (code += data));

  return new Promise((resolve, reject) => {
    proc.on("exit", () =>
      code.includes("ERROR")
        ? reject(code)
        : resolve(processOutput(code, startAddress))
    );
    proc.on("error", () => reject(code));
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
