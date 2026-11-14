import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, mkdir, readdir, lstat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";
import { recordingBatchBytes } from "../src/recording-format.ts";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const captureName = new RegExp(`^(${uuid})(?:\\.[0-9]{6,})?\\.jsonl$`);
const endpoint = new RegExp(`^/__dev/recordings/(${uuid})$`);
const retryGraceMs = 60_000, abandonedMs = 5 * 60_000;
type Session = { batch: number; event: number; hash: string; failed: boolean; closed: boolean; bytes: number;
  chunk: number; file: string; metadata: object; seen: number };
type Capture = { size: number; modified: number };
class Rejection extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function recordingMiddleware(directory: string, limit = 2 * 1024 ** 3, revision = "unknown") {
  await mkdir(directory, { recursive: true });
  const captures = new Map<string, Capture>();
  let used = 0, pruned = 0;
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (!file.isFile() || !captureName.test(file.name)) continue;
    const info = await lstat(join(directory, file.name));
    captures.set(file.name, { size: info.size, modified: info.mtimeMs }); used += info.size;
  }
  const sessions = new Map<string, Session>(), busy = new Set<string>();
  let writes = Promise.resolve();

  async function write(id: string, batch: number, body: string) {
    const now = Date.now();
    // Bound retry metadata as well as live sessions; closed tabs need not send a final batch.
    for (const [key, session] of sessions) {
      if (now - session.seen > (session.closed || session.failed ? retryGraceMs : abandonedMs)) sessions.delete(key);
    }
    const retired = [...sessions].filter(([, s]) => s.closed || s.failed);
    for (const [key] of retired.slice(0, Math.max(0, retired.length - 128))) sessions.delete(key);
    let session = sessions.get(id);
    const hash = createHash("sha256").update(body).digest("hex");
    const acknowledgement = (s: Session) => ({ batch: s.batch, bytes: s.bytes, file: s.file, pruned });
    if (session?.failed) throw new Rejection(410, "Recording incomplete after a write failure; reload to start a new capture");
    if (session && batch === session.batch && hash === session.hash) { session.seen = now; return acknowledgement(session); }
    if (session?.closed) throw new Rejection(410, "Recording already ended; reload to start a new capture");
    if (!session && batch !== 0) throw new Rejection(409, "Recording session lost or expired; reload the Viewer to start a new capture");
    if (batch !== (session?.batch ?? -1) + 1) throw new Rejection(409, "Duplicate or out-of-order recording batch");
    const lines = body.split("\n");
    if (lines.pop() !== "" || !lines.length || lines.length > 8192) throw new Rejection(400, "Expected newline-terminated JSON records");
    let event = session?.event ?? 0;
    const records = lines.map((line, index) => {
      let record;
      try { record = JSON.parse(line); } catch { throw new Rejection(400, "Invalid JSON record"); }
      if (!record || typeof record.type !== "string" || record.type.length > 80 || record.sequence !== event++ || !Number.isFinite(record.atMs) || record.atMs < 0) throw new Rejection(400, "Invalid record envelope or event sequence");
      if (record.sequence === 0 && (record.type !== "session" || record.version !== 1 || !Number.isFinite(record.timeOrigin))) throw new Rejection(400, "Missing recording session header");
      if (record.type === "checkpoint" && (record.version !== 1 || !Array.isArray(record.state?.connections) || (record.sequence > 1 && index !== 0))) throw new Rejection(400, "A chunk must start with a valid checkpoint");
      if (record.type === "recording-end" && index !== lines.length - 1) throw new Rejection(400, "Records after recording-end");
      return record;
    });
    if (!session) {
      if ([...captures.keys()].some(file => file.startsWith(id + "."))) throw new Rejection(409, "Recording ID already exists; reload to start a new capture");
      if ([...sessions.values()].filter(s => !s.closed && !s.failed).length >= 64) throw new Rejection(429, "64 recordings are already active; close an unused Viewer tab");
      session = { batch: -1, event: 0, hash: "", failed: false, closed: false, bytes: 0, chunk: -1, file: "", metadata: records[0], seen: now };
    }
    const rotate = batch === 0 || (records[0].type === "checkpoint" && records[0].sequence > 1);
    const chunk = session.chunk + (rotate ? 1 : 0);
    const file = `${id}.${String(chunk).padStart(6, "0")}.jsonl`;
    const header = rotate ? JSON.stringify({ type: "recording", version: 2, id, chunk, createdAt: new Date(now).toISOString(), revision,
      firstSequence: records[0].sequence, session: session.metadata }) + "\n" : "";
    const data = header + body, bytes = Buffer.byteLength(data);
    const protectedFiles = new Set([...sessions.values()].filter(s => !s.closed && !s.failed && !(s === session && rotate)).map(s => s.file));
    const candidates = [...captures].filter(([name]) => !protectedFiles.has(name)).sort((a, b) => a[1].modified - b[1].modified || a[0].localeCompare(b[0]));
    if (bytes > limit || used + bytes - candidates.reduce((sum, [, capture]) => sum + capture.size, 0) > limit) {
      throw new Rejection(507, "Recording budget is occupied by active chunks; close unused Viewer tabs or increase the storage budget");
    }
    for (const [name, capture] of candidates) {
      if (used + bytes <= limit) break;
      try { await unlink(join(directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      captures.delete(name); used -= capture.size; pruned++;
    }
    sessions.set(id, session);
    try {
      // O_APPEND without O_CREAT prevents silently recreating a manually removed chunk without its checkpoint.
      await appendFile(join(directory, file), data, { flag: rotate ? "wx" : constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, mode: 0o600 });
    } catch (error) {
      session.failed = true;
      // A failed append may have written a prefix. Keep disk accounting accurate, but never retry it.
      const info = await lstat(join(directory, file)).catch(() => undefined);
      if (info?.isFile()) {
        used += info.size - (captures.get(file)?.size ?? 0);
        captures.set(file, { size: info.size, modified: info.mtimeMs });
      }
      throw error;
    }
    used += bytes;
    captures.set(file, { size: (captures.get(file)?.size ?? 0) + bytes, modified: now });
    session.batch = batch; session.event = event; session.hash = hash; session.bytes += bytes;
    session.chunk = chunk; session.file = file; session.seen = now;
    session.closed = records.at(-1).type === "recording-end";
    return acknowledgement(session);
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/__dev/recordings/")) { next(); return; }
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    let locked: string | undefined;
    try {
      if (req.method !== "POST") throw new Rejection(405, "Use POST");
      let origin: URL;
      try { origin = new URL(req.headers.origin ?? ""); } catch { throw new Rejection(403, "Same-origin requests only"); }
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host || req.headers["x-xr-recording"] !== "1") throw new Rejection(403, "Same-origin recording requests only");
      if (req.headers["content-type"] !== "application/x-ndjson") throw new Rejection(415, "Expected application/x-ndjson");
      const match = endpoint.exec(req.url);
      if (!match) throw new Rejection(400, "Invalid recording ID");
      const id = match[1], batch = Number(req.headers["x-recording-batch"]);
      if (!/^\d+$/.test(String(req.headers["x-recording-batch"])) || !Number.isSafeInteger(batch)) throw new Rejection(400, "Invalid batch number");
      if (busy.size >= 8 || busy.has(id)) throw new Rejection(429, "Recording writers busy");
      busy.add(id); locked = id;
      if (Number(req.headers["content-length"]) > recordingBatchBytes) throw new Rejection(413, "Recording batch exceeds 2 MiB");
      const chunks: Buffer[] = [];
      let size = 0;
      req.setTimeout(5000, () => req.destroy());
      for await (const chunk of req) {
        size += chunk.length;
        if (size > recordingBatchBytes) throw new Rejection(413, "Recording batch exceeds 2 MiB");
        chunks.push(Buffer.from(chunk));
      }
      req.setTimeout(0);
      const body = Buffer.concat(chunks).toString("utf8");
      // All pruning and writes share one queue, including batches from different tabs.
      const pending = writes.then(() => write(id, batch, body));
      writes = pending.then(() => {}, () => {});
      reply(200, await pending);
    } catch (error) {
      reply(error instanceof Rejection ? error.status : 500, { error: error instanceof Rejection ? error.message : "Recording storage operation failed; capture may be incomplete. Check disk space and permissions." });
    } finally {
      if (locked) busy.delete(locked);
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
