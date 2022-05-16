#!/usr/bin/env node
if (process.argv.includes("--winUAE")) {
  require("./out/src/debugAdapterWinUAE");
} else {
  require("./out/src/debugAdapter");
}
