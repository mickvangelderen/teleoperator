import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const compiler = process.env.FLATC || "flatc";
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
if (version.stdout?.trim() !== "flatc version 25.9.23") {
  throw new Error(
    "Install flatc 25.9.23 or set FLATC to its path; see protocol/README.md",
  );
}
const output = fileURLToPath(new URL("../src/generated", import.meta.url));
mkdirSync(output, { recursive: true });
const result = spawnSync(
  compiler,
  [
    "--ts",
    "-o",
    output,
    fileURLToPath(new URL("../../protocol/wire.fbs", import.meta.url)),
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error("FlatBuffers generation failed");
