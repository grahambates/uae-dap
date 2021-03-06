# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.2] - 2022-06-13

### Fixed

- Signed memory references were always negative!

## [0.7.1] - 2022-06-13

### Fixed

- Non-decimal numbers not supported in memory reference

## [0.7.0] - 2022-06-12

### Added

- Interrupt addresses in variables list
- Source constants in variable list
- Size/Sign fields for register variables

### Changed

- Symbol names in stack trace
- Uses source references for disassembled sources, rather than writing to temp files
- Improved memory expressions - supports size and sign options
- Logpoint expressions formatted in hexadecimal for consistency
- Nicer syntax for expressions and commands, updated help text
- Better completions in REPL

### Fixed

- Support memory read in logpoint expressions

## [0.6.0] - 2022-06-06

### Added

- Conditional breakpoints
- Logpoints

### Fixed

- Better handling of stop on entry with WinUAE. Avoids race condition ands sends correct 'reason' property.
- Data breakpoint info request was broken.

## [0.5.2] - 2022-06-04

### Fixed

- Null coalesce for variable format
- Missing type export and variable formats
- Return formatted value for set variable

## [0.5.1] - 2022-06-01

### Fixed

- Support copper index in breakpoint source

## [0.5.0] - 2022-05-31

### Added

- Custom registers in scope
- Additional number formats

### Fixed

- WinUAE support

## [0.4.0] - 2022-05-28

### Changed

- Pass memory format in launch arguments

## [0.3.2] - 2022-05-27

### Added

- Custom command for disassembled file contents

### Fixed

- Expressions in dbgasm addresses
- CPU dbgasm formatting

## [0.3.0] - 2022-05-27

### Changed

- Abstract breakpoint storage. This will allow the vscode extension to make storage persistent
- Refactor for vscode hooks

### Fixed

- Use correct variable format property name
- Prevent child process starting in inspect mode

## [0.2.1] - 2022-05-25

### Changed

- Add additional exports to index

### Fixed

- Automatically detect wasm path
- Ignore .github dir
- Set correct main path

## [0.2.0] - 2022-05-25

### Changed

- Big refactor and cleanup
- Copper disassembly to temporary files

## [0.1.0] - 2022-05-18

### Added

- Tests migrated from VS Code extension

### Changed

- Use wasm build of `cstool` to remove dependency on binary
- Refactor / cleanup

### Fixed

- Expression parsing handles numeric literals
- NeoVim 'thread already stopped' issue on step events

## [0.0.0] - 2022-05-13

### Added

- Initial release
