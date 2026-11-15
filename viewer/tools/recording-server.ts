import { mkdir, open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { MAX_RECORDING_BATCH_BYTES, MAX_RECORDING_BYTES, RECORDING_HEADER, RECORD_HEADER_BYTES } from "../src/recording.ts";

class Rejection extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function recordingMiddleware(directory: string) {
  await mkdir(directory, { recursive: true });
  const busy = new Set<string>();
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/__dev/recordings/")) { next(); return; }
    let id: string | undefined;
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== "POST") throw new Rejection(405, "Use POST");
      let origin: URL;
      try { origin = new URL(req.headers.origin ?? ""); } catch { throw new Rejection(403, "Same-origin requests only"); }
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host || req.headers["x-xr-recording"] !== "1") throw new Rejection(403, "Same-origin recording requests only");
      if (req.headers["content-type"] !== "application/octet-stream") throw new Rejection(415, "Expected application/octet-stream");
      const match = /^\/__dev\/recordings\/([0-9a-f]{32})$/.exec(req.url);
      if (!match) throw new Rejection(400, "Invalid recording ID");
      const offset = Number(req.headers["x-recording-offset"]);
      if (!/^\d+$/.test(String(req.headers["x-recording-offset"])) || !Number.isSafeInteger(offset) || offset > MAX_RECORDING_BYTES) throw new Rejection(400, "Invalid recording offset");
      if (busy.has(match[1])) throw new Rejection(409, "Recording write in progress");
      id = match[1]; busy.add(id);
      if (Number(req.headers["content-length"]) > MAX_RECORDING_BATCH_BYTES) throw new Rejection(413, "Recording batch too large");
      const chunks: Buffer[] = [];
      let size = 0;
      req.setTimeout(5000, () => req.destroy());
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_RECORDING_BATCH_BYTES) throw new Rejection(413, "Recording batch too large");
        chunks.push(chunk);
      }
      req.setTimeout(0);
      const body = Buffer.concat(chunks);
      let at = 0;
      if (!offset) {
        if (!body.subarray(0, RECORDING_HEADER.length).equals(RECORDING_HEADER)) throw new Rejection(400, "Invalid recording header");
        at = RECORDING_HEADER.length;
      }
      if (!size) throw new Rejection(400, "Empty recording batch");
      while (at < size) {
        if (size - at < RECORD_HEADER_BYTES) throw new Rejection(400, "Incomplete recording frame");
        const length = body.readUInt32LE(at), flags = body[at + 4], time = body.readDoubleLE(at + 5);
        if (flags > 3 || !Number.isFinite(time) || time < 0 || length > size - at - RECORD_HEADER_BYTES) throw new Rejection(400, "Invalid recording frame");
        at += RECORD_HEADER_BYTES + length;
      }
      if (offset + size > MAX_RECORDING_BYTES) throw new Rejection(413, "Recording reached 128 MiB");
      const file = await open(join(directory, `${id}.xrop`), offset ? "r+" : "wx", 0o600);
      try {
        if ((await file.stat()).size !== offset) throw new Rejection(409, "Recording offset does not match the saved prefix");
        try {
          let written = 0;
          while (written < size) {
            const result = await file.write(body, written, size - written, offset + written);
            if (!result.bytesWritten) throw new Error("Recording write made no progress");
            written += result.bytesWritten;
          }
        } catch (error) {
          await file.truncate(offset); // Retain the last complete batch after a short/failed write.
          throw error;
        }
      } finally { await file.close(); }
      reply(200, { bytes: offset + size });
    } catch (error) {
      reply(error instanceof Rejection ? error.status : 500, { error: error instanceof Rejection ? error.message : "Recording write failed; check disk space and permissions." });
    } finally {
      req.setTimeout(0);
      if (id) busy.delete(id);
    }
  };
}

export function recordingPlugin(): Plugin {
  return {
    name: "xr-viewer-recording",
    configResolved(config) { config.server.fs.deny.push("**/.artifacts/recordings/**"); },
    async configureServer(server) {
      const middleware = await recordingMiddleware(fileURLToPath(new URL("../../.artifacts/recordings/", import.meta.url)));
      // Leave Vite's host checks in front of this development-only endpoint.
      return () => { server.middlewares.use((req, res, next) => { void middleware(req, res, next); }); };
    },
  };
}
