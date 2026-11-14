import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { recordingMiddleware } from "../tools/recording-server.ts";

// Run with CHROMIUM_EXECUTABLE=... pnpm exec tsx tests/recording-browser.ts.
// Small limits exercise the real Worker without touching developer recordings.
const executablePath = process.env.CHROMIUM_EXECUTABLE;
assert.ok(executablePath, "Set CHROMIUM_EXECUTABLE to a Chromium/Chrome executable");
const directory = await mkdtemp(join(tmpdir(), "xr-recording-browser-"));
const limit = 32 * 1024;
let middleware = await recordingMiddleware(directory, limit, "browser-test");
let dropped = false;
const attempts: number[] = [];
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)), configFile: false,
  define: { __OPERATOR_TARGET__: JSON.stringify("recording-test") },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "test-recording",
    transform(code, id) {
      if (id.endsWith("/src/recording-format.ts")) return code.replace("64 * 1024 ** 2", "4096");
    },
    configureServer(vite) {
      return () => vite.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/__dev/recordings/")) {
          attempts.push(Number(req.headers["x-recording-batch"]));
          if (!dropped) {
            const end = res.end.bind(res);
            res.end = ((...args: Parameters<typeof res.end>) => {
              if (res.statusCode === 200 && !dropped) { dropped = true; res.destroy(); return res; }
              return end(...args);
            }) as typeof res.end;
          }
        }
        void middleware(req, res, next);
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => document.querySelector("#recording-status")?.getAttribute("title")?.includes("older chunks removed"), undefined, { timeout: 20_000 });
  assert.equal(await page.locator("#recording-status").textContent(), "Recording · rolling history");
  assert.equal(await page.locator("#recording-status").getAttribute("class"), "tag");
  await page.evaluate(async () => {
    // @ts-expect-error This URL is served by Vite in the browser.
    const { recording } = await import("/src/recording.ts");
    await recording.stop("browser-test");
  });
  await page.waitForFunction(() => document.querySelector("#recording-status")?.textContent === "Saved");
  assert.deepEqual(errors, []);
  assert.ok(dropped && attempts.filter(batch => batch === 0).length === 2, "a lost acknowledgement must retry the original batch");
  const files = (await readdir(directory)).sort();
  assert.ok(files.length > 1);
  assert.ok(!files.some(file => file.endsWith(".000000.jsonl")), "the original chunk should have been pruned");
  let size = 0, previous: number | undefined;
  for (const file of files) {
    size += (await stat(join(directory, file))).size;
    const text = await readFile(join(directory, file), "utf8");
    assert.ok(text.endsWith("\n"));
    const [header, ...records] = text.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(header.version, 2);
    assert.equal(records[0].type, "checkpoint");
    assert.equal(header.firstSequence, records[0].sequence);
    assert.ok(Array.isArray(records[0].state.connections));
    for (const record of records) {
      if (previous !== undefined) assert.equal(record.sequence, previous + 1, "rotation and retry must preserve a continuous event stream");
      previous = record.sequence;
    }
  }
  assert.ok(size <= limit);
  // Exercise a maximum-size protocol packet and a checkpoint larger than the normal batch target.
  middleware = await recordingMiddleware(directory, 4 * 1024 ** 2, "large-packet-test");
  await page.reload();
  await page.evaluate(async () => {
    // @ts-expect-error This URL is served by Vite in the browser.
    const { recording } = await import("/src/recording.ts");
    recording.packet("large-packet", "received", "reliable", new Uint8Array(1024 ** 2).fill(123));
    await recording.flush();
    recording.add({ type: "checkpoint", version: 1, state: { connections: [], text: "é".repeat(180_000), counter: 2n ** 60n } });
    await recording.stop("large-packet-test");
  });
  await page.waitForFunction(() => document.querySelector("#recording-status")?.textContent === "Saved");
  const all = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), "utf8"))))
    .flatMap(text => text.trimEnd().split("\n").map(line => JSON.parse(line)));
  const packet = all.find(record => record.type === "packet" && record.connection === "large-packet");
  assert.ok(packet);
  assert.deepEqual(Buffer.from(packet.base64, "base64"), Buffer.alloc(1024 ** 2, 123));
  const checkpoint = all.find(record => record.type === "checkpoint" && record.state.text);
  assert.equal(checkpoint.state.text, "é".repeat(180_000));
  assert.equal(checkpoint.state.counter.$bigint, (2n ** 60n).toString());
  assert.deepEqual(errors, []);
  console.log(`PASS: browser Worker checkpoints, rotation, pruning, lost-ack retry, status, final flush, 1 MiB packets and large checkpoints (${files.length} retained chunks, ${size} bytes).`);
} finally {
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
