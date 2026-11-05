import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../src/generated", import.meta.url));
mkdirSync(output, { recursive: true });
const result = spawnSync(
  "python3",
  [
    fileURLToPath(new URL("../../tools/flatc.py", import.meta.url)),
    "--ts",
    "-o",
    output,
    fileURLToPath(new URL("../../protocol/wire.fbs", import.meta.url)),
  ],
  { stdio: "inherit" },
);
if (result.error) {
  throw new Error("Python 3 is required to prepare flatc; see protocol/README.md", {
    cause: result.error,
  });
}
if (result.status !== 0) throw new Error("FlatBuffers generation failed");
