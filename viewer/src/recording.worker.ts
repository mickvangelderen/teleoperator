import type { WorkerRecord } from "./recording";
import { recordingBatchBytes, recordingChunkBytes, stringifyRecording } from "./recording-format";

let id = "", batch = 0, sending = false, failed = false;
const queue: { line: string; size: number; cost: number; boundary: boolean }[] = [];
const encoder = new TextEncoder();
let queuedSize = 0, chunkSize = 0, checkpointRequested = false;
let lastEventAt = performance.now();

onmessage = ({ data }: MessageEvent<WorkerRecord & { id?: string; flush?: boolean }>) => {
  if (data.id) { id = data.id; return; }
  if (failed) return;
  if (data.flush) { void flush(); return; }
  const { event, bytes, cost } = data;
  lastEventAt = performance.now();
  if (bytes) {
    const array = new Uint8Array(bytes);
    let binary = "";
    for (let i = 0; i < array.length; i += 8192) binary += String.fromCharCode(...array.subarray(i, i + 8192));
    event.base64 = btoa(binary);
  }
  const line = stringifyRecording(event) + "\n", size = encoder.encode(line).byteLength;
  const boundary = event.type === "checkpoint" && event.sequence > 1;
  if (boundary) { chunkSize = 0; checkpointRequested = false; }
  queue.push({ line, size, cost, boundary }); queuedSize += size; chunkSize += size;
  // Ask the main thread for an ordered snapshot after all preceding packet callbacks.
  if (chunkSize >= recordingChunkBytes && !checkpointRequested) {
    checkpointRequested = true; postMessage({ checkpoint: true });
  }
  if (queuedSize >= 256 * 1024 || boundary) void flush();
};

async function flush() {
  if (sending || failed || !queue.length) return;
  sending = true;
  let body = "", cost = 0, size = 0;
  while (queue.length) {
    const item = queue[0];
    if (item.size > recordingBatchBytes || (body && (item.boundary || size + item.size > 256 * 1024))) break;
    queue.shift(); body += item.line; cost += item.cost; size += item.size; queuedSize -= item.size;
  }
  try {
    if (!body) throw new Error("Single recording event or checkpoint exceeds the 2 MiB batch limit");
    let saved: { batch: number; bytes: number; file: string; pruned: number } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`/__dev/recordings/${id}`, {
          method: "POST", headers: { "Content-Type": "application/x-ndjson", "X-XR-Recording": "1", "X-Recording-Batch": String(batch) },
          body, signal: AbortSignal.timeout(5000),
        });
        const result = await response.json();
        if (response.ok && result.batch === batch && Number.isFinite(result.bytes) && typeof result.file === "string" && Number.isFinite(result.pruned)) { saved = result; break; }
        if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(result.error || `Recording endpoint returned ${response.status}`);
        if (attempt === 2) throw new Error(result.error || "Recording endpoint unavailable");
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException) || attempt === 2) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!saved) throw new Error("Recording endpoint unavailable");
    batch++; postMessage({ cost, ...saved });
  } catch (error) {
    failed = true; queue.length = 0;
    postMessage({ error: error instanceof Error ? error.message : "Recording upload failed" });
    close();
  } finally { sending = false; }
  if (queue.length && !failed) void flush();
}
setInterval(() => {
  void flush();
  // Keep an open, idle tab distinct from an abandoned session on the server.
  if (performance.now() - lastEventAt >= 60_000) { lastEventAt = performance.now(); postMessage({ heartbeat: true }); }
}, 250);
