# UAE Debug Adapter Protocol

[Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) for Amiga assembly development with
[FS-UAE](https://fs-uae.net/) or [WinUAE](https://www.winuae.net/).

Adapted from @prb28's [vscode-amiga-assembly](https://github.com/prb28/vscode-amiga-assembly) extension,
to create stand-alone adapter for use with other editors that support Debug Adapter Protocol.

Needs @prb28's patched FS-UAE. You can download this as a [prebuilt binary](https://github.com/prb28/vscode-amiga-assembly-binaries).

## Installation

```
npm i -g uae-dap
```

## Usage

Tested with [nvim-dap](https://github.com/mfussenegger/nvim-dap) and FS-UAE.
Here's an example configuration:

```lua
local home = os.getenv('HOME')

dap.adapters.asm68k = {
  type = 'executable',
  command = 'uae-dap',
  options = { initialize_timeout_sec = 10 },
}

dap.configurations.asm68k = {
  {
    type = 'asm68k',
    request = 'launch',
    program = '${workspaceFolder}/uae/dh0/gencop',
    cwd = '${workspaceFolder}',
    -- custom settings:
    stopOnEntry = false,
    serverName = "localhost",
    serverPort = 6860,
    trace = false,
    startEmulator = true,
    emulator = home .. "/amiga/bin/fs-uae",
    emulatorWorkingDir = home .."/amiga/bin",
    emulatorOptions = {
      "--hard_drive_0=${workspaceFolder}/uae/dh0",
      "--remote_debugger=200",
      "--use_remote_debugger=true",
      "--automatic_input_grab=0"
    },
  }
}

```
