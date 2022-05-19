/* eslint-disable @typescript-eslint/ban-types */
import * as path from "path";
import { URI as Uri } from "vscode-uri";
import * as fs from "fs";
import { readFile, access } from "fs/promises";
import {
  Hunk,
  HunkParser,
  SourceLine,
  HunkType,
  Symbol,
} from "./amigaHunkParser";

export class FileParser {
  public hunks = new Array<Hunk>();
  private resolvedSourceFilesNames = new Map<string, string>();
  private sourceFilesCacheMap = new Map<string, Array<string>>();
  private loaded = false;

  constructor(
    private uri: Uri,
    private pathReplacements?: Record<string, string>,
    private sourcesRootPaths?: Array<string>
  ) {}

  public async parse(): Promise<boolean> {
    if (this.loaded) {
      return true;
    } else {
      const parser = new HunkParser();
      try {
        this.hunks = await parser.readFile(this.uri);
        this.loaded = true;
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  public getCodeData(): Uint32Array[] {
    const codeDataArray = new Array<Uint32Array>();
    for (const hunk of this.hunks) {
      if (hunk.hunkType === HunkType.CODE && hunk.codeData) {
        codeDataArray.push(hunk.codeData);
      }
    }
    return codeDataArray;
  }

  public async getSymbols(
    filename: string | undefined
  ): Promise<Array<[Symbol, number | undefined]>> {
    await this.parse();
    const symbols = Array<[Symbol, number | undefined]>();
    let normFilename = filename;
    if (normFilename) {
      normFilename = normalize(normFilename);
    }
    for (const hunk of this.hunks) {
      if (hunk.symbols) {
        if (normFilename) {
          const sourceFiles = hunk.lineDebugInfo;
          if (sourceFiles) {
            for (const srcFile of sourceFiles) {
              // Is there a path replacement
              const name = await this.resolveFileName(srcFile.name);
              if (this.areSameSourceFileNames(name, normFilename)) {
                for (const s of hunk.symbols) {
                  symbols.push([s, hunk.segmentsId]);
                }
                break;
              }
            }
          }
        } else {
          for (const s of hunk.symbols) {
            symbols.push([s, hunk.segmentsId]);
          }
        }
      }
    }
    return symbols;
  }

  protected tryFindLine(
    filename: string,
    lines: Array<SourceLine>,
    offset: number
  ): [string, number] | null {
    let sourceLine = 0;
    let wasOver = false;

    for (const line of lines) {
      if (line.offset === offset) {
        //println!("Matching source {} line {}", filename, line.line);
        return [filename, line.line];
      }
      if (line.offset <= offset) {
        sourceLine = line.line;
      } else if (line.offset > offset) {
        wasOver = true;
      }
    }

    if (wasOver) {
      //println!("Partial Matching source {} line {}", filename, sourceLine);
      return [filename, sourceLine];
    } else {
      return null;
    }
  }

  private async getSourceLineText(
    filename: string,
    line: number
  ): Promise<[string, string | null]> {
    const resolvedFileName = await this.resolveFileName(filename);
    let contents: Array<string> | undefined =
      this.sourceFilesCacheMap.get(resolvedFileName);
    if (!contents) {
      // Load source file
      const fileContentsString = await readFile(resolvedFileName, "utf8");
      contents = fileContentsString.split(/\r\n|\r|\n/g);
      this.sourceFilesCacheMap.set(resolvedFileName, contents);
    }
    if (contents && line < contents.length) {
      return [resolvedFileName, contents[line]];
    }
    return [resolvedFileName, null];
  }

  public async resolveFileLine(
    segId: number,
    offset: number
  ): Promise<[string, number, string | null] | null> {
    await this.parse();
    if (segId >= this.hunks.length) {
      return null;
    }
    const hunk = this.hunks[segId];
    let sourceLineText = null;

    const source_files = hunk.lineDebugInfo;
    if (source_files) {
      for (const srcFile of source_files) {
        const data = this.tryFindLine(srcFile.name, srcFile.lines, offset);
        if (data) {
          // transform the file path to a local one
          let resolvedFileName = await this.resolveFileName(data[0]);
          if (data[1] > 0) {
            [resolvedFileName, sourceLineText] = await this.getSourceLineText(
              resolvedFileName,
              data[1] - 1
            );
          }
          return [resolvedFileName, data[1], sourceLineText];
        }
      }
    }
    return null;
  }

  private async resolveFileName(filename: string): Promise<string> {
    let resolvedFileName = this.resolvedSourceFilesNames.get(filename);
    if (!resolvedFileName) {
      resolvedFileName = filename;
      if (this.pathReplacements) {
        const normalizedFilename = normalize(resolvedFileName);
        for (const key in this.pathReplacements) {
          const normalizedKey = normalize(key);
          if (normalizedFilename.indexOf(normalizedKey) >= 0) {
            const value = this.pathReplacements[key];
            if (value) {
              resolvedFileName = normalizedFilename.replace(
                normalizedKey,
                value
              );
              break;
            }
          }
        }
      }

      // search the file in the workspace
      if (this.sourcesRootPaths && !(await exists(resolvedFileName))) {
        for (const rootPath of this.sourcesRootPaths) {
          const checkedPath = path.join(rootPath, resolvedFileName);
          if (await exists(checkedPath)) {
            resolvedFileName = checkedPath;
            break;
          }
        }
      }
      resolvedFileName = normalize(resolvedFileName);
      this.resolvedSourceFilesNames.set(filename, resolvedFileName);
    }
    return resolvedFileName;
  }

  public areSameSourceFileNames(sourceA: string, sourceB: string): boolean {
    if (path.isAbsolute(sourceA) && path.isAbsolute(sourceB)) {
      if (process.platform === "win32") {
        return (
          path.normalize(sourceA).toLowerCase() ===
          path.normalize(sourceB).toLowerCase()
        );
      } else {
        return path.normalize(sourceA) === path.normalize(sourceB);
      }
    }
    if (process.platform === "win32") {
      return (
        path.basename(sourceB).toLowerCase() ===
        path.basename(sourceA).toLowerCase()
      );
    } else {
      return path.basename(sourceB) === path.basename(sourceA);
    }
  }

  public async getAddressSeg(
    filename: string,
    fileLine: number
  ): Promise<[number, number] | null> {
    await this.parse();
    const normFilename = normalize(filename);
    for (let i = 0; i < this.hunks.length; i++) {
      const hunk = this.hunks[i];
      const sourceFiles = hunk.lineDebugInfo;
      if (sourceFiles) {
        for (const srcFile of sourceFiles) {
          // Is there a path replacement
          const name = await this.resolveFileName(srcFile.name);
          if (this.areSameSourceFileNames(name, normFilename)) {
            for (const line of srcFile.lines) {
              if (line.line === fileLine) {
                return [i, line.offset];
              }
            }
          }
        }
      }
    }
    return null;
  }

  public async getAllSegmentIds(filename: string): Promise<number[]> {
    await this.parse();
    const segIds: number[] = [];
    const normFilename = normalize(filename);
    for (let i = 0; i < this.hunks.length; i++) {
      const hunk = this.hunks[i];
      const sourceFiles = hunk.lineDebugInfo;
      if (sourceFiles) {
        for (const srcFile of sourceFiles) {
          // Is there a path replacement
          const name = await this.resolveFileName(srcFile.name);
          if (this.areSameSourceFileNames(name, normFilename)) {
            segIds.push(i);
          }
        }
      }
    }
    return segIds;
  }
}

/**
 * Normalizes a path
 * @param inputPath Path to normalize
 * @return Normalized path
 */
function normalize(inputPath: string): string {
  let newDName = inputPath.replace(/\\+/g, "/");
  // Testing Windows derive letter -> to uppercase
  if (newDName.length > 0 && newDName.charAt(1) === ":") {
    const fChar = newDName.charAt(0).toUpperCase();
    newDName = fChar + ":" + newDName.substring(2);
  }
  return newDName;
}

const exists = (file: string) =>
  access(file, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);