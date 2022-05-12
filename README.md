# UAE DAP

Debug Adapter Protocol for Amiga development with [FS-UAE](https://fs-uae.net/) or [WinUAE](https://www.winuae.net/).

Adapted from [vscode-amiga-assembly](https://github.com/prb28/vscode-amiga-assembly) by
[prb28](https://github.com/prb28) to create stand-alone adapter for use with other editors
that support [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/).

Needs [prb28's patched FS-UAE binary](https://github.com/prb28/vscode-amiga-assembly-binaries) and capstone `cstool`.

Very much work-in-progress!

Tested with [nvim-dap](https://github.com/mfussenegger/nvim-dap). Here's an example config:

```lua
dap.adapters.asm68k = {
  type = 'executable',
  command = os.getenv('HOME') .. '/uae-dap/cli.js',
  options = { initialize_timeout_sec = 10 },
}

local cwd = vim.fn.getcwd()
local home = os.getenv('HOME')

dap.configurations.asm68k = {
  {
    type = 'asm68k',
    request = 'launch',
    program = cwd .. '/uae/dh0/main',
    cwd = cwd,
    stopOnEntry = false,
    serverName = 'localhost',
    serverPort = 6860,
    trace = false,
    cstool = home .. '/amiga/bin/cstool',
    startEmulator = true,
    emulator = home .. '/amiga/bin/fs-uae',
    emulatorWorkingDir = home ..'/amiga/bin',
    emulatorOptions = {
      '--hard_drive_0=' .. cwd .. '/uae/dh0',
      '--remote_debugger=200',
      '--use_remote_debugger=true',
      '--automatic_input_grab=0'
    },
  }
}

```
