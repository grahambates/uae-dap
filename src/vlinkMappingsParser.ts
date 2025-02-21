/**
 * Extract hunk and symbol info vlink mappings (-M option)
 */

import { readFile } from "fs/promises";
import { DebugInfo, Section } from "./sections";

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
): Promise<Section[]> {
  const buffer = await readFile(filename);
  return parseVlinkMappings(buffer.toString());
}

/**
 * Parse mappings string data
 */
export function parseVlinkMappings(contents: string): Section[] {
  const lines = contents.split("\n");
  let docSection = DocSection.NONE;
  let currentSection: string | null = null;
  let currentDebug: DebugInfo | null = null;
  const sections = new Map<string, Section>();

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
      if (match) currentSection = match[1];
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
          const address = Number("0x" + start);
          // Size and Allocated seem to be the wrong way round - BSS claims allocated=0
          // Handling them this way seems to work anyway
          const allocSize = Number("0x" + size);
          const dataSize = allocated ? Number("0x" + allocated) : allocSize;

          const section: Section = {
            name,
            index: sections.size,
            address,
            allocSize,
            dataSize,
            symbols: [],
            lineDebugInfo: [],
          };
          sections.set(name, section);
        }
        break;
      }

      case DocSection.SYMBOLS: {
        const match = line.match(/(0x[0-9a-f]+) ([^:]+):/);
        if (match) {
          const section = currentSection && sections.get(currentSection);
          if (section) {
            section.symbols.push({
              offset: Number(match[1]) - section.address, // relative to start of section?
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
          currentSection = sectionMatch[1];
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
              baseOffset: 0,
              lines: [],
              sourceFilename,
            };
            const section = currentSection && sections.get(currentSection);
            if (section) {
              section.lineDebugInfo.push(currentDebug);
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

  return [...sections.values()];
}
