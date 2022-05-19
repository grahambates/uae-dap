/* eslint-disable @typescript-eslint/ban-types */
import * as path from "path";
import { readFile } from "fs/promises";
import { URI as Uri } from "vscode-uri";
import { Hunk, HunkParser, SourceLine } from "./amigaHunkParser";
import { exists, normalize, areSameSourceFileNames } from "../utils/files";

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
          if (areSameSourceFileNames(name, normFilename)) {
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
  private tryFindLine(
    filename: string,
    lines: Array<SourceLine>,
    offset: number
  ): [string, number] | null {
    let sourceLine = 0;
    let wasOver = false;

    for (const line of lines) {
      if (line.offset === offset) {
        return [filename, line.line];
      }
      if (line.offset <= offset) {
        sourceLine = line.line;
      } else if (line.offset > offset) {
        wasOver = true;
      }
    }

    if (wasOver) {
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
}
