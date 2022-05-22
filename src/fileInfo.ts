/* eslint-disable @typescript-eslint/ban-types */
import * as path from "path";
import { readFile } from "fs/promises";
import { Hunk, HunkParser, SourceLine } from "./amigaHunkParser";
import { exists, normalize, areSameSourceFileNames } from "./utils/files";
import { splitLines } from "./utils/strings";

export interface LineInfo {
  filename: string;
  lineNumber: number;
  lineText: string | null;
}

export interface SegmentLocation {
  segmentId: number;
  offset: number;
}

/**
 * Extracts information about amiga executable file from parsed hunks
 */
export class FileInfo {
  private resolvedSourceFilesNames = new Map<string, string>();
  private sourceFilesCacheMap = new Map<string, Array<string>>();

  private constructor(
    public hunks: Hunk[],
    private pathReplacements?: Record<string, string>,
    private sourcesRootPaths?: Array<string>
  ) {}

  /**
   * Create instance
   */
  public static async create(
    filename: string,
    pathReplacements?: Record<string, string>,
    sourcesRootPaths?: Array<string>
  ): Promise<FileInfo> {
    const parser = new HunkParser();
    const hunks = await parser.readFile(filename);
    return new FileInfo(hunks, pathReplacements, sourcesRootPaths);
  }

  public async findLineAtLocation(
    segId: number,
    offset: number
  ): Promise<LineInfo | null> {
    const hunk = this.hunks[segId];

    if (hunk?.lineDebugInfo) {
      for (const srcFile of hunk.lineDebugInfo) {
        const lineNumber = this.findLineAtOffset(srcFile.lines, offset);
        if (lineNumber !== null) {
          const filename = await this.resolveFileName(srcFile.name);
          const lineText =
            lineNumber > 0
              ? await this.getSourceLineText(filename, lineNumber - 1)
              : null;
          return { filename, lineNumber, lineText };
        }
      }
    }
    return null;
  }

  public async findLocationForLine(
    filename: string,
    lineNumber: number
  ): Promise<SegmentLocation | null> {
    const normFilename = normalize(filename);
    for (let i = 0; i < this.hunks.length; i++) {
      const hunk = this.hunks[i];
      if (hunk.lineDebugInfo) {
        for (const srcFile of hunk.lineDebugInfo) {
          // Is there a path replacement
          const name = await this.resolveFileName(srcFile.name);
          if (areSameSourceFileNames(name, normFilename)) {
            for (const l of srcFile.lines) {
              if (l.line === lineNumber) {
                return { segmentId: i, offset: l.offset };
              }
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * Find the first source file from each hunk
   */
  public async getSourceFiles(): Promise<string[]> {
    const sourceFiles = new Set<string>();
    for (const h of this.hunks) {
      if (h.lineDebugInfo?.length) {
        const resolvedFileName = await this.resolveFileName(
          h.lineDebugInfo[0].name
        );
        sourceFiles.add(resolvedFileName);
      }
    }
    return Array.from(sourceFiles);
  }
  private findLineAtOffset(
    lines: Array<SourceLine>,
    offset: number
  ): number | null {
    let lineNumber = 0;
    let wasOver = false;

    for (const l of lines) {
      if (l.offset === offset) {
        return l.line;
      }
      if (l.offset <= offset) {
        lineNumber = l.line;
      } else if (l.offset > offset) {
        wasOver = true;
      }
    }
    return wasOver ? lineNumber : null;
  }

  private async getSourceLineText(
    resolvedFileName: string,
    line: number
  ): Promise<string | null> {
    let contents = this.sourceFilesCacheMap.get(resolvedFileName);
    if (!contents) {
      // Load source file
      const fileContentsString = await readFile(resolvedFileName, "utf8");
      contents = splitLines(fileContentsString);
      this.sourceFilesCacheMap.set(resolvedFileName, contents);
    }
    return contents[line] ?? null;
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
