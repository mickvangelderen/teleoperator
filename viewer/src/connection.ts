import { decode, encode, subscribe, subscribeInputs, subscribeBody, updatePublication, unsubscribe, json, MAX_PACKET } from "./protocol";
import type { Accepted, Capabilities, Hello, Received, Sample, Skeleton, Reference, Tracking } from "./protocol";
import { Sequence, Latest } from "./statistics";
import { profiler } from "./performance";
import { recording, recordingId } from "./recording";

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
  streams: LiveStream[];
  skeletons: Map<string, Skeleton>;
  source: string;
  discarded: number;

};
export type Statistics = { messages: Sequence; samples: Sequence; consumer: Latest<Sample>; discarded: number; rate: number; age: number | null; stale: boolean };
export const initialStatistics = (): Statistics => ({ messages: new Sequence(), samples: new Sequence(false), consumer: new Latest(), discarded: 0, rate: 0, age: null, stale: true });
export type LiveStream = { descriptor: Accepted; sample: Sample | null; statistics: Statistics; newest: bigint; lastReceivedAt: number; rateAt: number; rateCount: bigint };
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
  streams: [], skeletons: new Map(), source: "unknown", discarded: 0,
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
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private helloSent = false;
  private probeId = 0n;
  private lastReplyAt = 0;
  private readonly probes = new Map<bigint, number>();
  private requestId = 1n;
  private readonly pending = new Set<bigint>();
  private readonly references = new Map<string, Reference>();
  private consumerTimer?: ReturnType<typeof setInterval>;
  private offset: number | null = null;
  private bestRtt = Infinity;
  private readonly requested = new Set<string>();
  constructor(private readonly update: (state: State) => void) {}

  async connect() {
    recording.add({ type: "connection", connection: this.recordingId, status: "connecting" });
    void fetch("/api/health", { signal: this.abort.signal }).then(r => r.json()).then(data => { if (!this.stopped) this.state.source = typeof data.source === "string" ? data.source : "unknown"; }).catch(() => {});
    this.setConsumerRate(30);
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
          this.send(this.control, bytes);
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
        const started = profiler.begin();
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new Error("Expected a binary protocol packet");
          const bytes = new Uint8Array(event.data);
          const arrivedAt = started ?? performance.now();
          profiler.transfer("received", bytes.length, arrivedAt);
          recording.packet(this.recordingId, "received", name, bytes, arrivedAt);
          const message = decode(bytes, name);
          if (name === "tracking" && !this.state.capabilities) return;
          if (name === "control")
            this.record("Received", name, message.kind, bytes.length, message);
          if (message.kind === "Tracking") {
            this.acceptTracking(message, bytes.length, arrivedAt);
            this.state.received++; this.state.bytes += bytes.length;
            return;
          }
          this.accept(message);
          if (name === "tracking")
            this.record("Received", name, message.kind, bytes.length, message);
          this.emit();
        } catch (error) {
          recording.add({ type: "receive-error", connection: this.recordingId, channel: name, error: String(error) });
          if (name === "tracking") this.state.discarded++;
          if (name === "control")
            this.fail(
              error instanceof Error ? error.message : "Invalid control packet",
            );
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
      this.state.detail = message.pose ? "Receiving head and controller poses." : "Hello accepted. No tracking sources advertised.";
      for (const space of message.spaces) this.addReference(space);
      if (message.pose && !this.requested.has("pose")) {
        this.requested.add("pose"); const id = ++this.requestId;
        this.sendRequest(id, "Subscribe poses", subscribe(id, message.pose.sources));
      }
      if (message.controller && !this.requested.has("controller")) {
        this.requested.add("controller"); const id = ++this.requestId;
        this.sendRequest(id, "Subscribe inputs", subscribeInputs(id, message.controller.inputs));
      }
      if (message.body && !this.requested.has("body")) {
        this.requested.add("body"); const id = ++this.requestId;
        this.sendRequest(id, "Subscribe body", subscribeBody(id, message.body.source, message.body.jointSet));
      }
      clearTimeout(this.deadline);
      if (!this.timer) {
        this.probe();
        this.timer = setInterval(() => this.probe(), 1000);
      }
    } else if (message.kind === "ClockReply") {
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
      if (this.state.rtt < this.bestRtt) {
        this.bestRtt = this.state.rtt;
        this.offset = Number(message.receivedAt + message.sentAt) / 2e6 - (sent + this.lastReplyAt) / 2;
      }
    } else if (message.kind === "ReferenceSpaceDefinition") {
      this.addReference(message);
    } else if (message.kind === "SkeletonDefinition") {
      const old = this.state.skeletons.get(`${message.id}:${message.version}`);
      if (old && json(old) !== json(message)) throw new Error("Skeleton version changed contents");
      this.state.skeletons.set(`${message.id}:${message.version}`, message);
      if (this.state.skeletons.size > 128) this.state.skeletons.delete(this.state.skeletons.keys().next().value!);
    } else if (message.kind === "StreamAccepted") {
      if (message.requestId && !this.pending.delete(message.requestId)) throw new Error("Unexpected stream acceptance");
      const old = this.state.streams.find(s => s.descriptor.streamId === message.streamId);
      if (old?.descriptor.subscriptionId === message.subscriptionId) old.descriptor = message;
      else {
        const stream: LiveStream = { descriptor: message, sample: null, statistics: initialStatistics(), newest: 0n, lastReceivedAt: 0, rateAt: performance.now(), rateCount: 0n };
        if (old) { stream.statistics.messages = old.statistics.messages; this.state.streams[this.state.streams.indexOf(old)] = stream; }
        else this.state.streams.push(stream);
      }
    } else if (message.kind === "RequestRejected") {
      if (!this.pending.delete(message.requestId)) throw new Error("Unexpected request rejection");
      this.state.detail = message.reason;
    } else if (message.kind === "StreamClosed") {
      if (message.requestId && !this.pending.delete(message.requestId)) throw new Error("Unexpected stream closure");
      this.state.streams = this.state.streams.filter(s => s.descriptor.streamId !== message.streamId);
    } else if (message.kind === "ServerResumed") {
      this.offset = null; this.bestRtt = Infinity; this.probes.clear(); this.state.rtt = null;
    }
  }

  private addReference(reference: Reference) {
    const key = `${reference.id}:${reference.version}`, old = this.references.get(key);
    if (old && json(old) !== json(reference)) throw new Error("Reference version changed contents");
    this.references.set(key, reference);
    if (this.references.size > 128) this.references.delete(this.references.keys().next().value!);
  }

  private acceptTracking(message: Tracking, bytes: number, arrivedAt: number) {
    const live = this.state.streams.find(s => s.descriptor.streamId === message.streamId && s.descriptor.subscriptionId === message.subscriptionId);
    if (!live) { this.state.discarded++; return; }
    const stream = live.descriptor, stats = live.statistics;
    if (message.samples.length > stream.history || message.samples.some(s => s.type !== stream.type || (s.type === "pose" && s.poses.length !== stream.sources.length) || (s.type === "controller" && (s.inputs.length !== stream.inputs.length || s.inputs.some((input, i) => input.type !== stream.inputs[i].type))))) throw new Error("Tracking layout differs from descriptor");
    profiler.trackingArrival(stream.type, `${this.recordingId}:${stream.streamId}:${stream.subscriptionId}`, bytes, arrivedAt);
    if (!stats.messages.accept(message.messageNumber)) return;
    for (const sample of message.samples) {
      if (stream.reference && !this.references.has(`${stream.reference.id}:${sample.referenceVersion}`)) { stats.discarded++; continue; }
      if (sample.body) {
        const skeleton = this.state.skeletons.get(`${stream.skeleton?.id}:${sample.body.skeletonVersion}`);
        if (!skeleton || !this.references.has(`${skeleton.reference.id}:${skeleton.reference.version}`)) { stats.discarded++; continue; }
        if (skeleton.joints.length !== sample.poses.length || skeleton.jointSet !== stream.jointSet) throw new Error("Body layout differs from skeleton");
      }
      stats.samples.accept(sample.number);
      if (sample.number > live.newest) {
        live.newest = sample.number;
        live.lastReceivedAt = performance.now();
        // History is for gap recovery; only the newest available sample reaches the consumer.
        if (sample === message.samples.at(-1)) stats.consumer.put(sample);
      }
    }
  }

  setConsumerRate(rate: number) {
    if (![5, 30, 60].includes(rate)) throw new Error("Unsupported consumer rate");
    recording.add({ type: "consumer-rate", connection: this.recordingId, hz: rate });
    clearInterval(this.consumerTimer);
    this.consumerTimer = setInterval(() => {
      const now = performance.now();
      for (const live of this.state.streams) {
        const stats = live.statistics, sample = stats.consumer.take();
        if (sample) live.sample = sample;
        stats.stale = !live.sample || now - live.lastReceivedAt > 500;
        stats.age = live.sample && this.offset !== null ? now + this.offset - Number(live.sample.acquiredAt) / 1e6 : null;
        if (now - live.rateAt >= 1000) { stats.rate = Number(stats.messages.unique - live.rateCount) * 1000 / (now - live.rateAt); live.rateAt = now; live.rateCount = stats.messages.unique; }
      }
      this.emit();
    }, 1000 / rate);
  }
  setPublication(rate: number, history: number, type = "pose") {
    const stream = this.state.streams.find(s => s.descriptor.type === type)?.descriptor;
    if (!stream) return;
    const id = ++this.requestId;
    this.sendRequest(id, "UpdatePublication", updatePublication(id, stream.streamId, rate, history));
  }
  stopTracking(type = "pose") {
    const stream = this.state.streams.find(s => s.descriptor.type === type)?.descriptor;
    if (!stream) return;
    const id = ++this.requestId;
    this.sendRequest(id, "Unsubscribe", unsubscribe(id, stream.streamId));
  }
  private sendRequest(id: bigint, kind: string, bytes: Uint8Array<ArrayBuffer>) {
    if (this.control.readyState !== "open" || this.control.bufferedAmount > MAX_PACKET) throw new Error("Control channel unavailable");
    this.pending.add(id); this.send(this.control, bytes); this.record("Sent", "control", kind, bytes.length, { requestId: id });
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
    this.send(this.tracking, bytes);
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
  private send(channel: RTCDataChannel, bytes: Uint8Array<ArrayBuffer>) {
    const at = performance.now();
    try { channel.send(bytes); }
    catch (error) {
      recording.add({ type: "send-error", connection: this.recordingId, channel: channel.label, error: String(error), length: bytes.length }, bytes, at);
      throw error;
    }
    recording.packet(this.recordingId, "sent", channel.label, bytes, at);
    profiler.transfer("sent", bytes.length, at);
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
    clearInterval(this.timer);
    clearInterval(this.consumerTimer);
    this.pc.close();
    this.probes.clear();
    this.state.status = "Disconnected";
    this.state.detail = "Disconnected. Reconnect to inspect the device.";
    this.state.control = "closed";
    this.state.tracking = "closed";
    this.state.rtt = null;
    this.state.hello = null;
    this.state.capabilities = null;
    this.state.streams = []; this.state.skeletons.clear();
    this.update(this.state);
  }
}
