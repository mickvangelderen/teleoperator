import { decode, encode, MAX_PACKET } from "./protocol";
import type { Capabilities, Hello, Received } from "./protocol";

export type Entry = {
  id: number;
  at: Date;
  direction: "Received" | "Sent";
  channel: "control" | "tracking";
  kind: string;
  bytes: number;
  value: unknown;
};
export type State = {
  status: "Disconnected" | "Connecting" | "Connected" | "Error";
  detail: string;
  hello: Hello | null;
  capabilities: Capabilities | null;
  control: string;
  tracking: string;
  received: number;
  sent: number;
  bytes: number;
  rtt: number | null;
  entries: Entry[];
};
export const initialState = (): State => ({
  status: "Disconnected",
  detail: "Connect to inspect the device.",
  hello: null,
  capabilities: null,
  control: "closed",
  tracking: "closed",
  received: 0,
  sent: 0,
  bytes: 0,
  rtt: null,
  entries: [],
});

export class Connection {
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
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private helloSent = false;
  private probeId = 0n;
  private lastReplyAt = 0;
  private readonly probes = new Map<bigint, number>();
  constructor(private readonly update: (state: State) => void) {}

  async connect() {
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
        if (
          this.control.readyState === "open" &&
          this.tracking.readyState === "open" &&
          !this.helloSent
        ) {
          this.helloSent = true;
          const bytes = encode("ClientHello", 1n);
          this.control.send(bytes);
          this.record("Sent", "control", "ClientHello", bytes.length, {
            requestId: 1n,
            supportedVersions: [1],
          });
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
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new Error("Expected a binary protocol packet");
          const bytes = new Uint8Array(event.data);
          const message = decode(bytes, name);
          if (name === "tracking" && !this.state.capabilities) return;
          if (name === "control")
            this.record("Received", name, message.kind, bytes.length, message);
          this.accept(message);
          if (name === "tracking")
            this.record("Received", name, message.kind, bytes.length, message);
          this.emit();
        } catch (error) {
          if (name === "control")
            this.fail(
              error instanceof Error ? error.message : "Invalid control packet",
            );
        }
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
      if (text.length > MAX_PACKET)
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

  private accept(message: Received) {
    if (message.kind === "ServerHello") {
      if (!this.helloSent || this.state.hello || message.requestId !== 1n)
        throw new Error("Unexpected ServerHello");
      if (message.selectedVersion === 0) throw new Error(message.reason);
      if (message.selectedVersion !== 1)
        throw new Error("Server selected an unsupported version");
      this.state.hello = message;
    } else if (message.kind === "Capabilities") {
      if (!this.state.hello)
        throw new Error("Capabilities arrived before ServerHello");
      this.state.capabilities = message;
      this.state.status = "Connected";
      this.state.detail = "Hello accepted. No tracking sources advertised.";
      clearTimeout(this.deadline);
      if (!this.timer) {
        this.probe();
        this.timer = setInterval(() => this.probe(), 1000);
      }
    } else {
      const sent = this.probes.get(message.requestId);
      if (sent === undefined)
        throw new Error("Unknown or repeated clock reply");
      const elapsed = performance.now() - sent;
      const processing = Number(message.sentAt - message.receivedAt) / 1e6;
      if (!Number.isFinite(processing) || processing > elapsed + 1)
        throw new Error("Invalid clock duration");
      this.probes.delete(message.requestId);
      this.state.rtt = Math.max(0, elapsed - processing);
      this.lastReplyAt = performance.now();
    }
  }

  private probe() {
    if (
      this.stopped ||
      this.tracking.readyState !== "open" ||
      this.tracking.bufferedAmount > 4096
    )
      return;
    const now = performance.now();
    if (now - this.lastReplyAt > 5000) this.state.rtt = null;
    for (const [id, sent] of this.probes)
      if (now - sent > 5000) this.probes.delete(id);
    // The server bounds its deduplication set. Start another session after this budget.
    if (this.probeId >= 65_536n) {
      this.fail("Clock probe budget reached. Reconnect to continue.");
      return;
    }
    const id = ++this.probeId;
    const bytes = encode("ClockProbe", id);
    this.probes.set(id, now);
    this.tracking.send(bytes);
    this.record("Sent", "tracking", "ClockProbe", bytes.length, {
      requestId: id,
    });
    this.emit();
  }
  private record(
    direction: Entry["direction"],
    channel: Entry["channel"],
    kind: string,
    bytes: number,
    value: unknown,
  ) {
    if (direction === "Received") {
      this.state.received++;
      this.state.bytes += bytes;
    } else this.state.sent++;
    this.state.entries.push({
      id: this.state.received + this.state.sent,
      at: new Date(),
      direction,
      channel,
      kind,
      bytes,
      value,
    });
    // Keep discovery visible even after many clock probes.
    if (
      this.state.entries.filter((entry) => entry.channel === channel).length >
      50
    ) {
      this.state.entries.splice(
        this.state.entries.findIndex((entry) => entry.channel === channel),
        1,
      );
    }
  }
  private emit() {
    if (!this.stopped) this.update(this.state);
  }
  private fail(message: string) {
    this.close();
    this.state.status = "Error";
    this.state.detail = message;
    this.update(this.state);
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.deadline);
    clearInterval(this.timer);
    this.pc.close();
    this.probes.clear();
    this.state.status = "Disconnected";
    this.state.detail = "Disconnected. Reconnect to inspect the device.";
    this.state.control = "closed";
    this.state.tracking = "closed";
    this.state.rtt = null;
    this.state.hello = null;
    this.state.capabilities = null;
    this.update(this.state);
  }
}
