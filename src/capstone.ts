import { ExecutorHelper } from "./execHelper";
import { DebugInfo } from "./debugInfo";
import { URI as Uri } from "vscode-uri";

/**
 * Class to disassemble the m68k binaries
 */
export class Capstone {
  /** Path to the capstone executable */
  private cstoolPath: string;
  /** Executor to run cstools */
  private executor: ExecutorHelper;

  /**
   * Constructor
   * @param cstoolPath Path to Cstool
   */
  public constructor(cstoolPath: string) {
    this.cstoolPath = cstoolPath;
    this.executor = new ExecutorHelper();
  }

  /**
   * Disassemble a buffer
   * @param buffer Buffer to disassemble
   * @param cancellationToken Token to cancel the process
   */
  public async disassemble(
    buffer: string /*, cancellationToken?: CancellationToken*/
  ): Promise<string> {
    const args = ["m68k", buffer];
    const workspaceRootDir = this.getWorkspaceRootDir();
    let rootPath: string | null = null;
    if (workspaceRootDir) {
      rootPath = workspaceRootDir.fsPath;
    }
    const code = await this.executor.runToolRetrieveStdout(
      args,
      rootPath,
      this.cstoolPath,
      null
    );
    if (code.indexOf("ERROR") >= 0) {
      throw new Error(code);
    }
    return code;
  }

  /**
   * Disassemble a amiga hunk file
   * @param filename File to disassemble
   * @param cancellationToken Token to cancel the process
   */
  public async disassembleFile(
    filename: Uri /*, cancellationToken?: CancellationToken*/
  ): Promise<string> {
    const di = new DebugInfo(filename);
    if (await di.load()) {
      const codeDataArray = di.getCodeData();
      let allCode = "";
      for (const codeData of codeDataArray) {
        let s = "";
        for (const b of codeData) {
          s += this.padStartWith0(b.toString(16), 8);
        }
        const data = await this.disassemble(s);
        allCode += data + "\n";
      }
      return allCode;
    } else {
      throw new Error(`File '${filename}' could not be parsed`);
    }
  }

  /**
   * Setting the context to run the tests.
   * @param executor mocked executor
   */
  public setTestContext(executor: ExecutorHelper): void {
    this.executor = executor;
  }

  /**
   * Reads the workspace folder dir
   */
  private getWorkspaceRootDir(): Uri | null {
    // if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    //   return workspace.workspaceFolders[0].uri;
    // }
    return null;
  }

  private padStartWith0(stringToPad: string, targetLength: number): string {
    targetLength = targetLength >> 0; //truncate if number or convert non-number to 0;
    let padString = "0";
    if (stringToPad.length > targetLength) {
      return stringToPad;
    } else {
      targetLength = targetLength - stringToPad.length;
      if (targetLength > padString.length) {
        padString += padString.repeat(targetLength / padString.length); //append to original to ensure we are longer than needed
      }
      return padString.slice(0, targetLength) + stringToPad;
    }
  }
}
