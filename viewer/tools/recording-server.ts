import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";

const maxBatch = 1024 * 1024;
type Session = { batch: number; event: number; hash: string; busy: boolean; failed: boolean; bytes: number };
class Rejection extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function recordingMiddleware(directory: string, limit = 2 * 1024 ** 3, revision = "unknown") {
  await mkdir(directory, { recursive: true });
  let used = 0, active = 0;
  for (const file of await readdir(directory)) if (file.endsWith(".jsonl")) used += (await stat(join(directory, file))).size;
  const sessions = new Map<string, Session>();
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/__dev/recordings/")) { next(); return; }
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    let locked: Session | undefined;
    try {
      if (req.method !== "POST") throw new Rejection(405, "Use POST");
      let origin: URL;
      try { origin = new URL(req.headers.origin ?? ""); } catch { throw new Rejection(403, "Same-origin requests only"); }
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host || req.headers["x-xr-recording"] !== "1") throw new Rejection(403, "Same-origin recording requests only");
      if (req.headers["content-type"] !== "application/x-ndjson") throw new Rejection(415, "Expected application/x-ndjson");
      const match = /^\/__dev\/recordings\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(req.url);
      if (!match) throw new Rejection(400, "Invalid recording ID");
      const batch = Number(req.headers["x-recording-batch"]);
      if (!/^\d+$/.test(String(req.headers["x-recording-batch"])) || !Number.isSafeInteger(batch)) throw new Rejection(400, "Invalid batch number");
      if (active >= 8) throw new Rejection(429, "Recording writers busy");
      const id = match[1];
      let session = sessions.get(id);
      if (!session) {
        if (batch !== 0) throw new Rejection(409, "Recording session lost; reload the Viewer to start a new capture");
        if (sessions.size >= 64) throw new Rejection(429, "Recording session limit reached; restart the dev server");
        session = { batch: -1, event: 0, hash: "", busy: false, failed: false, bytes: 0 };
        sessions.set(id, session);
      }
      if (session.failed) throw new Rejection(410, "Recording incomplete after a write failure; reload to start a new capture");
      if (session.busy) throw new Rejection(429, "Recording batch in progress");
      session.busy = true; active++; locked = session;
      if (Number(req.headers["content-length"]) > maxBatch) throw new Rejection(413, "Recording batch exceeds 1 MiB");
      const chunks: Buffer[] = [];
      let size = 0;
      req.setTimeout(5000, () => req.destroy());
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBatch) throw new Rejection(413, "Recording batch exceeds 1 MiB");
        chunks.push(Buffer.from(chunk));
      }
      req.setTimeout(0);
      const body = Buffer.concat(chunks).toString("utf8"), hash = createHash("sha256").update(body).digest("hex");
      if (batch === session.batch && hash === session.hash) { reply(200, { batch, bytes: session.bytes }); return; }
      if (batch !== session.batch + 1) throw new Rejection(409, "Duplicate or out-of-order recording batch");
      const lines = body.split("\n");
      if (lines.pop() !== "" || !lines.length || lines.length > 8192) throw new Rejection(400, "Expected newline-terminated JSON records");
      let event = session.event;
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { throw new Rejection(400, "Invalid JSON record"); }
        if (!record || typeof record.type !== "string" || record.type.length > 80 || record.sequence !== event++ || !Number.isFinite(record.atMs) || record.atMs < 0) throw new Rejection(400, "Invalid record envelope or event sequence");
        if (record.sequence === 0 && (record.type !== "session" || record.version !== 1 || !Number.isFinite(record.timeOrigin))) throw new Rejection(400, "Missing recording session header");
      }
      const header = batch === 0 ? JSON.stringify({ type: "recording", version: 1, id, createdAt: new Date().toISOString(), revision }) + "\n" : "";
      const data = header + body, bytes = Buffer.byteLength(data);
      if (used + bytes > limit) throw new Rejection(507, "Recording storage limit reached (2 GiB by default); move captures out of .artifacts/recordings and restart the dev server");
      used += bytes;
      try { await appendFile(join(directory, `${id}.jsonl`), data, { flag: batch === 0 ? "wx" : "a", mode: 0o600 }); }
      catch (error) { session.failed = true; throw error; }
      session.batch = batch; session.event = event; session.hash = hash; session.bytes += bytes;
      reply(200, { batch, bytes: session.bytes });
    } catch (error) {
      reply(error instanceof Rejection ? error.status : 500, { error: error instanceof Rejection ? error.message : "Recording write failed; capture may be incomplete. Check disk space and permissions." });
    } finally {
      if (locked) { locked.busy = false; active--; }
    }
  };
}

export function recordingPlugin(): Plugin {
  return {
    name: "xr-viewer-recording",
    configResolved(config) { config.server.fs.deny.push("**/.artifacts/recordings/**"); },
    async configureServer(server) {
      const directory = fileURLToPath(new URL("../../.artifacts/recordings/", import.meta.url));
      let revision = "unknown";
      try {
        revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: server.config.root, encoding: "utf8" }).trim();
        if (execFileSync("git", ["diff", "HEAD", "--name-only"], { cwd: server.config.root, encoding: "utf8" }).trim()) revision += "-dirty";
      } catch { /* Source archives need not contain Git metadata. */ }
      const middleware = await recordingMiddleware(directory, undefined, revision);
      // Keep Vite's host checks in front of the recording endpoint.
      return () => { server.middlewares.use((req, res, next) => { void middleware(req, res, next); }); };
    },
  };
}
