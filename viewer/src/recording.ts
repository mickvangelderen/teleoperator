export type RecordingEvent = { type: string; [key: string]: unknown };
export type WorkerRecord = { event: RecordingEvent & { sequence: number; atMs: number }; cost: number; bytes?: ArrayBuffer };

// getRandomValues also works when the dev Viewer is opened over plain HTTP on a LAN.
export function recordingId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class Recorder {
  active = false;
  private worker?: Worker;
  private pending = 0;
  private sequence = 0;
  private status: (message: string, failed: boolean) => void = () => {};
  private id = "";
  private failed = false;
  private drain?: (error?: Error) => void;

  start(metadata: RecordingEvent, status: (message: string, failed: boolean) => void) {
    this.status = status;
    this.id = recordingId();
    this.sequence = this.pending = 0;
    try {
      this.worker = new Worker(new URL("./recording.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }) => {
        if (data.error) this.fail(data.error);
        else {
          this.pending -= data.cost;
          if (this.active) status(`Recording · ${this.id}.jsonl · ${(data.bytes / 1024 ** 2).toFixed(1)} MiB saved`, false);
          if (!this.pending) this.drain?.();
        }
      };
      this.worker.onerror = () => this.fail("Recording worker failed");
      this.active = true;
      this.worker.postMessage({ id: this.id });
      status(`Starting recording · ${this.id}.jsonl`, false);
      this.add({ ...metadata, type: "session", version: 1, timeOrigin: performance.timeOrigin, userAgent: navigator.userAgent });
    } catch { this.fail("Could not start the recording worker"); }
  }
  add(event: RecordingEvent, bytes?: Uint8Array, atMs = performance.now()) {
    if (!this.active || !this.worker) return;
    const cost = bytes ? bytes.byteLength * 2 + 1024 : JSON.stringify(event).length * 2 + 256;
    if (this.pending + cost > 4 * 1024 ** 2) {
      this.worker.postMessage({ event: { type: "recording-error", sequence: this.sequence++, atMs, reason: "4 MiB queue exceeded; subsequent records were not captured" }, cost: 0 });
      this.fail("Recording queue exceeded 4 MiB; capture is incomplete");
      return;
    }
    const buffer = bytes?.slice().buffer as ArrayBuffer | undefined;
    const record: WorkerRecord = { event: { ...event, sequence: this.sequence++, atMs }, cost, bytes: buffer };
    this.pending += cost;
    this.worker.postMessage(record, buffer ? [buffer] : []);
  }
  packet(connection: string, direction: "sent" | "received", channel: string, bytes: Uint8Array, atMs = performance.now()) {
    this.add({ type: "packet", connection, direction, channel, length: bytes.byteLength }, bytes, atMs);
  }
  private fail(reason: string) {
    this.active = false;
    this.failed = true;
    this.status(`Recording incomplete · ${reason}`, true);
    this.drain?.(new Error(reason));
  }
  async flush() {
    if (this.failed) throw new Error("Recording has failed");
    if (!this.pending) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.drain?.(new Error("Timed out waiting for recording acknowledgement")), 6000);
      this.drain = error => { clearTimeout(timeout); this.drain = undefined; if (error) reject(error); else resolve(); };
      this.worker?.postMessage({ flush: true });
    });
  }
  async stop(reason: string) {
    if (!this.active) return;
    this.add({ type: "recording-end", reason });
    this.active = false;
    try {
      await this.flush();
      this.status(`Recording saved · ${this.id}.jsonl`, false);
    } catch (error) { this.fail(error instanceof Error ? error.message : "Recording flush failed"); }
    finally { this.worker?.terminate(); }
  }
}
export const recording = new Recorder();
