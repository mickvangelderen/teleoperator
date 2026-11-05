import type { WorkerRecord } from "./recording";

let id = "", batch = 0, sending = false, failed = false;
const queue: { line: string; cost: number }[] = [];
let queuedSize = 0;

onmessage = ({ data }: MessageEvent<WorkerRecord & { id?: string; flush?: boolean }>) => {
  if (data.id) { id = data.id; return; }
  if (failed) return;
  if (data.flush) { void flush(); return; }
  const { event, bytes, cost } = data;
  if (bytes) {
    const array = new Uint8Array(bytes);
    let binary = "";
    for (let i = 0; i < array.length; i += 8192) binary += String.fromCharCode(...array.subarray(i, i + 8192));
    event.base64 = btoa(binary);
  }
  const line = JSON.stringify(event) + "\n";
  queue.push({ line, cost }); queuedSize += line.length;
  if (queuedSize >= 256 * 1024) void flush();
};

async function flush() {
  if (sending || failed || !queue.length) return;
  sending = true;
  let body = "", cost = 0;
  while (queue.length && body.length + queue[0].line.length <= 256 * 1024) {
    const item = queue.shift()!;
    body += item.line; cost += item.cost; queuedSize -= item.line.length;
  }
  try {
    if (!body) throw new Error("Single recording event exceeds the batch limit");
    let saved: { batch: number; bytes: number } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`/__dev/recordings/${id}`, {
          method: "POST", headers: { "Content-Type": "application/x-ndjson", "X-XR-Recording": "1", "X-Recording-Batch": String(batch) },
          body, signal: AbortSignal.timeout(5000),
        });
        const result = await response.json();
        if (response.ok && result.batch === batch && Number.isFinite(result.bytes)) { saved = result; break; }
        if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(result.error || `Recording endpoint returned ${response.status}`);
        if (attempt === 2) throw new Error(result.error || "Recording endpoint unavailable");
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException) || attempt === 2) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!saved) throw new Error("Recording endpoint unavailable");
    batch++; postMessage({ cost, bytes: saved.bytes });
  } catch (error) {
    failed = true; queue.length = 0;
    postMessage({ error: error instanceof Error ? error.message : "Recording upload failed" });
    close();
  } finally { sending = false; }
  if (queue.length && !failed) void flush();
}
setInterval(() => { void flush(); }, 250);
