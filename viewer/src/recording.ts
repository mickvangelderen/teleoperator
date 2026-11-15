// File: "XROPREC" followed by version byte 1. Each message is a little-endian
// u32 payload length, u8 flags (bit 0: unreliable, bit 1: sent by viewer),
// f64 milliseconds since capture started, then the unmodified wire payload.
// File order is the viewer's observed order across both channels/directions.
export const RECORDING_HEADER = Uint8Array.of(88, 82, 79, 80, 82, 69, 67, 1);
export const RECORD_HEADER_BYTES = 13;
export const MAX_RECORDING_BYTES = 128 * 1024 ** 2;
export const MAX_RECORDING_BATCH_BYTES = 2 * 1024 ** 2;

export class Recorder {
  readonly id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  readonly path = `.artifacts/recordings/${this.id}.xrop`;
  status: "recording" | "stopped" | "limit" | "error" = "recording";
  error = "";
  bytes = RECORDING_HEADER.length;
  savedBytes = 0;
  private readonly startedAt = performance.now();
  private readonly buffer = new Uint8Array(MAX_RECORDING_BATCH_BYTES);
  private readonly view = new DataView(this.buffer.buffer);
  private used = RECORDING_HEADER.length;
  private sending?: Promise<void>;
  private uploadFailed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.buffer.set(RECORDING_HEADER);
    this.timer = setInterval(() => { void this.flush(); }, 250);
    void this.flush();
  }

  packet(direction: "sent" | "received", channel: "reliable" | "unreliable", bytes: Uint8Array, atMs = performance.now()) {
    if (this.status !== "recording") return;
    const size = RECORD_HEADER_BYTES + bytes.byteLength;
    if (this.bytes + size > MAX_RECORDING_BYTES) { void this.stop("limit"); return; }
    if (this.used + size > this.buffer.length) void this.flush();
    if (this.used + size > this.buffer.length) {
      this.error = "Recording upload could not keep up; capture stopped.";
      void this.stop("error");
      return;
    }
    this.view.setUint32(this.used, bytes.byteLength, true);
    this.buffer[this.used + 4] = (channel === "unreliable" ? 1 : 0) | (direction === "sent" ? 2 : 0);
    this.view.setFloat64(this.used + 5, atMs - this.startedAt, true);
    this.buffer.set(bytes, this.used + RECORD_HEADER_BYTES);
    this.used += size;
    this.bytes += size;
    if (this.used >= 256 * 1024) void this.flush();
  }

  stop(reason: "stopped" | "limit" | "error" = "stopped") {
    if (this.status === "recording") this.status = reason;
    clearInterval(this.timer);
    return this.flush();
  }

  flush(): Promise<void> {
    return this.sending ??= this.upload().finally(() => { this.sending = undefined; });
  }

  private async upload() {
    while (this.used && !this.uploadFailed) {
      // At most one bounded batch is in flight and one is being filled.
      const body = this.buffer.slice(0, this.used);
      this.used = 0;
      try {
        const response = await fetch(`/__dev/recordings/${this.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-XR-Recording": "1", "X-Recording-Offset": String(this.savedBytes) },
          body, signal: AbortSignal.timeout(5000), keepalive: body.length <= 60 * 1024,
        });
        const result = await response.json();
        if (!response.ok || result.bytes !== this.savedBytes + body.length) throw new Error(result.error || "Recording upload failed");
        this.savedBytes = result.bytes;
      } catch (error) {
        this.uploadFailed = true;
        this.used = 0;
        this.error = error instanceof Error ? error.message : "Recording upload failed";
        this.status = "error";
        clearInterval(this.timer);
      }
    }
  }
}
