# MAME m68k Debug Adapter Protocol extension

## This is a modification of Graham Bates' [uae-dap](https://github.com/grahambates/uae-dap), turning it into a VS Code MAME debug extension for Motorola 68000 targets.

No build tools are included with this extension, it only contains the debugging adapter for launching and attaching to the MAME emulator.

Also, given the large size of MAME, it isn't included either, so you should download [MAME](https://www.mamedev.org/) for your platform and reference the MAME executable using the 'emulatorBin' property in a launch configuration (or add the parent folder to the OS path).

The directory part of the `program` property will be used to set MAME's `-rompath` argument, so put the bios for the target system in the same directory, and MAME should pick it up along with your ROM set.

### vlink

Debug symbols are fetched from a symbol file (generated during build) - this should be in [vlink](http://sun.hasenbraten.de/vlink/) symbol file format (`-M` argument). 

Note that a fairly **recent build of vlink is required** for outputting correct symbol files!

How to compile/assemble, link, and otherwise manipulate the build output, in order to generate a MAME ROM set, is beyond the scope of this document.

## Launch and attach configuration properties

| Property     | Description                               | Mandatory                                     | Example                                         |
| ------------ | ----------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| type         | "mame-m68k-debugger"                      | yes                                           |                                                 |
| request      | "launch" or "attach"                      | yes                                           | "launch"                                        |
| name         | &lt;some meaningful name&gt;              | yes                                           | "MAME debug"                                    |
| noDebug      | Launch without debugging                  | no (defaults to false)                        |                                                 |
| trace        | Enable extra logging                      | no (defaults to false)                        |                                                 |
| stopOnEntry  | Stop the target after attaching           | no (defaults to false)                        |                                                 |
| emulatorBin  | Path to MAME executable                   | no[^1] (tries to run "mame" if not specified) | "C:/Users/JohnDoe/Downloads/mame0273b/mame.exe" |
| emulatorArgs | Additional MAME options                   | no                                            | ["-window", "-nomaximize"]                      |
| program      | Path to ROM folder/zip in build output    | yes[^1]                                       | "${workspaceFolder}/build/mslug2"               |
| mappings     | Path to vlink symbol file in build output | yes[^2]                                       | "${workspaceFolder}/build/symbols.txt"          |
| serverPort   | Listen-port of MAME gdb stub              | no[^2] (defaults to 2345)                     | 6789                                            |
 
[^1]: Only relevant for launch requests, attach requests won't try to start the emu.
[^2]: Only relevant for debug configs (`noDebug`: false)
