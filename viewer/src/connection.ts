import { profiler } from "./performance";
import { recording, recordingId } from "./recording";

export type State = {
  status: "Disconnected" | "Connecting" | "Transport open" | "Error";
  detail: string;
  control: string;
  tracking: string;
  source: string;
};
export const initialState = (): State => ({
  status: "Disconnected",
  detail: "Protocol migration in progress; tracking is unavailable.",
  control: "closed",
  tracking: "closed",
  source: "unknown",
});

export class Connection {
  private readonly recordingId = recordingId();
  private recordedState = "";
  readonly state = initialState();
  private readonly pc = new RTCPeerConnection({ iceServers: [] });
  private readonly abort = new AbortController();
  private readonly control = this.pc.createDataChannel("control", {
    ordered: true,
    protocol: "xrop",
  });
  private readonly tracking = this.pc.createDataChannel("tracking", {
    ordered: false,
    maxRetransmits: 0,
    protocol: "xrop",
  });
  private deadline?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly update: (state: State) => void) {}

  async connect() {
    recording.add({ type: "connection", connection: this.recordingId, status: "connecting" });
    void fetch("/api/health", { signal: this.abort.signal }).then(r => r.json()).then(data => { if (!this.stopped) this.state.source = typeof data.source === "string" ? data.source : "unknown"; }).catch(() => {});
    this.state.status = "Connecting";
    this.state.detail = "Opening a WebRTC connection…";
    this.emit();
    this.deadline = setTimeout(
      () =>
        this.fail(
          "Connection timed out. Check that the Quest is awake and reachable.",
        ),
      15_000,
    );
    this.pc.onconnectionstatechange = () => {
      if (
        ["failed", "disconnected", "closed"].includes(
          this.pc.connectionState,
        ) &&
        !this.stopped
      )
        this.fail(
          "The device connection closed. Reconnect to start a new handshake.",
        );
    };
    for (const [name, channel] of [
      ["control", this.control],
      ["tracking", this.tracking],
    ] as const) {
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        if (this.stopped) return;
        this.state[name] = "open";
        if (this.control.readyState === "open" && this.tracking.readyState === "open") {
          clearTimeout(this.deadline);
          this.state.status = "Transport open";
          this.state.detail = "WebRTC channels open. Tracking is unavailable during protocol migration.";
        }
        this.emit();
      };
      channel.onclose = () => {
        if (!this.stopped)
          this.fail(`${name} channel closed. Reconnect to try again.`);
      };
      channel.onerror = () => {
        if (!this.stopped) this.fail(`${name} channel failed.`);
      };
      channel.onmessage = (event) => {
        if (this.stopped) return;
        const started = profiler.begin();
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new Error("Expected a binary protocol packet");
          const bytes = new Uint8Array(event.data);
          const arrivedAt = started ?? performance.now();
          profiler.transfer("received", bytes.length, arrivedAt);
          recording.packet(this.recordingId, "received", name, bytes, arrivedAt);
          throw new Error("Tracking protocol implementation removed (WIP).");
        } catch (error) {
          recording.add({ type: "receive-error", connection: this.recordingId, channel: name, error: String(error) });
          this.fail(error instanceof Error ? error.message : "Invalid data channel message");
        } finally { profiler.end("receive", started); }
      };
    }
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.pc.removeEventListener("icegatheringstatechange", check);
          this.abort.signal.removeEventListener("abort", cancelled);
        };
        const check = () => {
          if (this.pc.iceGatheringState === "complete") {
            cleanup();
            resolve();
          }
        };
        const cancelled = () => {
          cleanup();
          reject(new Error("Connection cancelled"));
        };
        this.pc.addEventListener("icegatheringstatechange", check);
        this.abort.signal.addEventListener("abort", cancelled, { once: true });
        if (this.abort.signal.aborted) cancelled();
        else check();
      });
      if (this.stopped) return;
      recording.add({ type: "signaling", connection: this.recordingId, direction: "sent", value: this.pc.localDescription?.toJSON() });
      const response = await fetch("/api/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.pc.localDescription),
        signal: this.abort.signal,
      });
      if (!response.ok)
        throw new Error(
          `Signaling failed (${response.status}). Check the device address and network.`,
        );
      const text = await response.text();
      recording.add({ type: "signaling", connection: this.recordingId, direction: "received", status: response.status, value: text });
      if (text.length > 65_536)
        throw new Error("Signaling answer too large");
      const answer = JSON.parse(text) as RTCSessionDescriptionInit;
      if (answer.type !== "answer" || typeof answer.sdp !== "string")
        throw new Error("Invalid signaling answer");
      if (!this.stopped) await this.pc.setRemoteDescription(answer);
    } catch (error) {
      if (!this.stopped)
        this.fail(error instanceof Error ? error.message : "Connection failed");
    }
  }

  private emit() {
    const state = `${this.state.status}: ${this.state.detail}`;
    if (state !== this.recordedState) {
      recording.add({ type: "connection-state", connection: this.recordingId, status: this.state.status, detail: this.state.detail });
      this.recordedState = state;
    }
    if (!this.stopped) this.update(this.state);
  }
  private fail(message: string) {
    recording.add({ type: "connection-error", connection: this.recordingId, error: message });
    this.close();
    this.state.status = "Error";
    this.state.detail = message;
    this.update(this.state);
  }
  close() {
    if (this.stopped) return;
    recording.add({ type: "connection", connection: this.recordingId, status: "closed" });
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.deadline);
    this.pc.close();
    this.state.status = "Disconnected";
    this.state.detail = "Disconnected. Reconnect to inspect the device.";
    this.state.control = "closed";
    this.state.tracking = "closed";
    this.update(this.state);
  }
}
