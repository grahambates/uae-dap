# UAE Debug Adapter Protocol

## This is a work in progress trying to transform Graham Bates' [uae-dap](https://github.com/grahambates/uae-dap) into a mame m68k debug adapter.

Compatibility with UAE is compromised in some cases.. you have been warned!

Stand-alone[Debug Adapter](https://microsoft.github.io/debug-adapter-protocol/) for Amiga assembly development with
[FS-UAE](https://fs-uae.net/) or [WinUAE](https://www.winuae.net/).

This package was extracted from the [vscode-amiga-assembly](https://github.com/prb28/vscode-amiga-assembly) extension,
to create stand-alone adapter for use with other editors that support [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/).

This library relies on patched binaries for FS-UAE and WinUAE with changes from @prb28 and @bartman to provide a remote
GDB server. These are now bundled with the package for Windows, Mac and Debian Linux x64. Note that the FS-UAE
implementation is now based on the current 4.x dev build, and as such has some limitations and missing features. It is
totally usable though and is much closer to current WinUAE, allowing us to share common patches rather than maintaining
two separate GDB implementations.

Tested with:

- NeoVim [nvim-dap plugin](https://github.com/mfussenegger/nvim-dap). See example below.
- Emacs [dap-mode](https://github.com/emacs-lsp/dap-mode).
  See [emacs-m68k](https://github.com/themkat/emacs-m68k) (currently using 0.x version).

## Installation

Install the `uae-dap` npm package globally: `npm i -g uae-dap`

## Usage

The Amiga binaries to be debugged must include SAS/C-compatible LINE DEBUG hunks. Use the `-linedebug` option is vasm
and `-hunkdebug` in vbcc to include these.

### Example configuration:

Here's a minimal example configuration for NeoVim with the [Amiga Assembly example workspace](https://github.com/prb28/vscode-amiga-wks-example).

```lua
dap.adapters.asm68k = {
  type = 'executable',
  command = 'uae-dap',
  options = { initialize_timeout_sec = 20 },
}

dap.configurations.asm68k = {
  {
    type = 'asm68k',
    request = 'launch',
    program = '${workspaceFolder}/uae/dh0/gencop',
    stopOnEntry = true,
    emulatorType = "fs-uae",
    emulatorArgs = {
      "--chip_memory=2048",
      "--amiga_model=A1200",
      "--automatic_input_grab=0",
      "--floppy_drive_0_sounds=off",
      "--hide_hud=1",
      "--window_resizable=1"
    }
  }
}
```

### Configuration options:

| Option          | Type                   | Description                                                                                   | Default                                              |
| --------------- | ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `program`       | `string`               | Local path of target Amiga binary                                                             | -                                                    |
| `remoteProgram` | `string`               | Remote path of target Amiga binary                                                            | `"SYS:{basename(program)}"`                          |
| `stopOnEntry`   | `boolean`              | Automatically stop target after launch                                                        | `false`                                              |
| `noDebug`       | `boolean`              | Just launch emulator without debugging                                                        | `false`                                              |
| `trace`         | `boolean`              | Enable verbose logging                                                                        | `false`                                              |
| `serverName`    | `string`               | Host name of the debug server                                                                 | `"localhost"`                                        |
| `serverPort`    | `number`               | Port number of the debug server                                                               | `2345`                                               |
| `exceptionMask` | `number`               | Mask used to catch the exceptions                                                             | `0b1111111111100`                                    |
| `emulatorType`  | `"fs-uae" \| "winuae"` | Emulator program type                                                                         | `"winuae"` on windows, `"fs-uae"` on other platforms |
| `emulatorBin`   | `string`               | Path of emulator executable                                                                   | bundled version                                      |
| `emulatorArgs`  | `string[]`             | Additional CLI args to pass to emulator program. Remote debugger args are added automatically | `[]`                                                 |

## Changes

### 1.0

- Changed configuration schema
- No longer supports the patched fs-uae 3.x implementation.
