/**
 * Extract hunk and symbol info vlink mappings (-M option)
 */

import { match } from "assert";
import { readFile } from "fs/promises";
import { DebugInfo, Hunk, HunkType, MemoryType } from "./amigaHunkParser";

enum DocSection {
  NONE,
  FILES,
  SECTIONS,
  SYMBOLS,
  LINKER_SYMBOLS,
  LINES,
}

/**
 * Parse mappings text file
 */
export async function parseVlinkMappingsFile(
  filename: string
): Promise<Hunk[]> {
  const buffer = await readFile(filename);
  return parseVlinkMappings(buffer.toString());
}

/**
 * Parse mappings string data
 */
export function parseVlinkMappings(contents: string): Hunk[] {
  const lines = contents.split("\n");
  let docSection = DocSection.NONE;
  let currentHunk: string | null = null;
  let currentDebug: DebugInfo | null = null;
  const hunks = new Map<string, Hunk>();

  for (const line of lines) {
    // Section headings:
    if (line.startsWith("Files:")) {
      docSection = DocSection.FILES;
      continue;
    } else if (line.startsWith("Section mapping")) {
      docSection = DocSection.SECTIONS;
      continue;
    } else if (line.startsWith("Symbols of ")) {
      docSection = DocSection.SYMBOLS;
      const match = line.match(/Symbols of ([^ ]+):/);
      if (match) currentHunk = match[1];
      continue;
    } else if (line.startsWith("Linker symbols")) {
      docSection = DocSection.LINKER_SYMBOLS;
      continue;
    } else if (line.startsWith("Source file line offsets")) {
      docSection = DocSection.LINES;
      continue;
    }

    // Process line in current section:
    switch (docSection) {
      case DocSection.SECTIONS: {
        const match = line.match(
          /^ +([0-9a-f]+) ([^ ]+) +\(size ([0-9a-f]+)(, allocated ([0-9a-f]+))?\)/
        );
        if (match) {
          const [_, start, name, size, _1, allocated] = match;
          // TODO:
          // this is WRONG, at least for Amiga. Lucky it's not used!
          // Start seems to be set for ORG absolute addresses, and doesn't tell use where is the file the section is.
          const fileOffset = Number("0x" + start);
          // Size and Allocated seem to be the wrong way round - BSS claims allocated=0
          // Handling them this way seems to work anyway
          const allocSize = Number("0x" + size);
          const dataSize = allocated ? Number("0x" + allocated) : allocSize;
          const hunkType = allocSize === 0 ? HunkType.BSS : HunkType.CODE;

          // Allow section naming convention for mem type like Bartman's toolchain
          let memType = MemoryType.ANY;
          if (name.endsWith(".MEMF_CHIP")) {
            memType = MemoryType.CHIP;
          } else if (name.endsWith(".MEMF_FAST")) {
            memType = MemoryType.FAST;
          }

          const hunk: Hunk = {
            index: hunks.size,
            fileOffset,
            dataOffset: fileOffset + 4, // The first longword is the length
            allocSize,
            dataSize,
            hunkType,
            memType,
            reloc32: [], // Not currently used anyway
            symbols: [],
            lineDebugInfo: [],
          };
          hunks.set(name, hunk);
        }
        break;
      }

      case DocSection.SYMBOLS: {
        const match = line.match(/(0x[0-9a-f]+) ([^:]+):/);
        if (match) {
          const hunk = currentHunk && hunks.get(currentHunk);
          if (hunk) {
            hunk.symbols.push({
              offset: Number(match[1]) - hunk.fileOffset, // relative to start of section?
              name: match[2],
            });
          }
        }
        break;
      }

      case DocSection.LINKER_SYMBOLS: {
        // not used?
        break;
      }

      case DocSection.LINES: {
        const sectionMatch = line.match(/^([^ :]+):/);
        if (sectionMatch) {
          currentHunk = sectionMatch[1];
          continue;
        }

        const lineMatch = line.match(
          /^ {2}(0x[0-9a-f]+) line ([0-9]+)( "([^"]+)")?/
        );
        if (lineMatch) {
          const offset = Number(lineMatch[1]);
          const lineNo = Number(lineMatch[2]);
          const sourceFilename = lineMatch[4];

          if (sourceFilename) {
            currentDebug = {
              baseOffset: 0, // TODO
              lines: [],
              sourceFilename,
            };
            const hunk = currentHunk && hunks.get(currentHunk);
            if (hunk) {
              hunk.lineDebugInfo.push(currentDebug);
            }
          }

          if (currentDebug) {
            currentDebug.lines.push({
              offset,
              line: lineNo,
            });
          }
        }
        break;
      }
    }
  }

  return [...hunks.values()];
}
