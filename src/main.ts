import { runCli } from "./cli.js";

// process.exit() で即時に落とさず exitCode だけ立てる。
// stdout / stderr を流し切ってから終わらせるため。
process.exitCode = await runCli(process.argv.slice(2));
