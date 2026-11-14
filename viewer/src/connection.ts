import { Session } from "./session";
import { preferredFormat, restGroup, periodic } from "./protocol";
import type { Request } from "./protocol";
import { profiler } from "./performance";
import { recording, recordingId } from "./recording";
import type { Freshness } from "./freshness";

export type State = {
  status: "Disconnected" | "Connecting" | "Connected" | "Error";
  detail: string;
  control: string;
  tracking: string;
  source: string;
  predictionHorizonMs?: number;
  session?: Session;
  freshness: Freshness;
};
export const initialState = (): State => ({
  status: "Disconnected",
  detail: "Connect to inspect tracking capabilities and current samples.",
  control: "closed",
  tracking: "closed",
  source: "unknown",
  freshness: { status: "Inactive", atMs: 0, streams: [] },
});

export class Connection {
  private readonly recordingId = recordingId();
  private recordedState = "";
  readonly state = initialState();
  readonly session = new Session();
  private offered = false;
  private readonly replacements = new Map<number, number>();
  private subscribed = false;
  private readonly pc = new RTCPeerConnection({ iceServers: [] });
  private readonly abort = new AbortController();
  private readonly control = this.pc.createDataChannel("reliable", {
    ordered: true,
    protocol: "xrop",
  });
  private readonly tracking = this.pc.createDataChannel("unreliable", {
    ordered: false,
    maxRetransmits: 0,
    protocol: "xrop",
  });
  private deadline?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private clockTimer?: ReturnType<typeof setInterval>;
  private freshnessTimer?: ReturnType<typeof setInterval>;
  private recordedFreshness = "";
  constructor(private readonly update: (state: State) => void) { this.state.session = this.session; }

  async connect() {
    if (this.stopped || this.state.status !== "Disconnected") return;
    profiler.reset();
    recording.add({ type: "connection", connection: this.recordingId, status: "connecting" });
    void fetch("/api/health", { signal: this.abort.signal }).then(r => r.json()).then(data => {
      if (this.stopped) return;
      this.state.source = typeof data.source === "string" ? data.source : "unknown";
      const horizon = data.prediction_horizon_ms;
      this.state.predictionHorizonMs = typeof horizon === "number" && Number.isFinite(horizon) && horizon >= 0 && horizon <= 1000 ? horizon : undefined;
      this.emit();
    }).catch(() => {});
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
          if (!this.offered) {
            this.offered = true;
            if (!this.send(this.session.start())) return;
            this.state.detail = this.session.detail;
          }
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
          if (!(event.data instanceof ArrayBuffer)) {
            if (name === "tracking") { this.session.discarded++; return; }
            throw new Error("Expected a binary protocol packet");
          }
          const bytes = new Uint8Array(event.data);
          const arrivedAt = started ?? performance.now();
          profiler.transfer("received", bytes.length, arrivedAt);
          recording.packet(this.recordingId, "received", name === "control" ? "reliable" : "unreliable", bytes, arrivedAt);
          if (name === "control") {
            for (const packet of this.session.control(bytes, arrivedAt)) profiler.trackingArrival(packet.id, `${this.recordingId}:${this.session.active.get(packet.id)?.generation}`, bytes.length, arrivedAt);
            for (const [id, previous] of this.replacements) {
              if (this.session.pending.has(id)) continue;
              this.replacements.delete(id);
              if (this.session.active.has(id) && this.session.active.has(previous)) this.send(this.session.stop(previous));
            }
            this.state.detail = this.session.detail;
            if (this.session.phase === "ready") {
              clearTimeout(this.deadline);
              this.state.status = "Connected";
              if (!this.subscribed) {
                this.subscribed = true;
                this.probeClock();
                this.clockTimer = setInterval(() => this.probeClock(), 1000);
                this.freshnessTimer = setInterval(() => this.emit(), 16);
                const c = this.session.capabilities!;
                c.groups.forEach((max, group) => {
                  const samples = c.descriptors.flatMap((d, descriptor) => d.group === group ? [{ descriptor, format: preferredFormat(d), space: d.spaces[0] ?? 0 }] : []);
                  const rest = restGroup(c, group);
                  if (samples.length && !this.stopped) this.publish({ id: group + 1, group, delivery: rest ? 2 : 1, schedule: rest ? { kind: "onChange" } : periodic(Math.min(max, 60)), samples });
                });
              }
            }
          } else {
            const packet = this.session.unreliable(bytes, arrivedAt);
            if (packet) profiler.trackingArrival(packet.id, `${this.recordingId}:${this.session.active.get(packet.id)?.generation}`, bytes.length, arrivedAt);
          }
          this.emit();
        } catch (error) {
          recording.add({ type: "receive-error", connection: this.recordingId, channel: name, error: String(error) });
          if (name === "control") this.fail(error instanceof Error ? error.message : "Invalid control message");
          else { this.session.discarded++; this.emit(); }
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

  private send(bytes: Uint8Array): boolean {
    try {
      if (this.control.readyState !== "open" || this.control.bufferedAmount + bytes.length > 1_048_576) throw new Error("Control channel is not ready to send");
      const negotiated = this.pc.sctp?.maxMessageSize;
      const limit = negotiated && Number.isFinite(negotiated) ? Math.min(16_384, Math.floor(negotiated)) : 16_384;
      if (limit < 1) throw new Error("Invalid data channel message limit");
      for (let offset = 0; offset < bytes.length; offset += limit) {
        const chunk = bytes.subarray(offset, offset + limit);
        this.control.send(chunk as Uint8Array<ArrayBuffer>);
        const now = performance.now();
        recording.packet(this.recordingId, "sent", "reliable", chunk, now);
        profiler.transfer("sent", chunk.length, now);
      }
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Control send failed");
      return false;
    }
  }
  private probeClock() {
    const limit = this.pc.sctp?.maxMessageSize;
    if (this.stopped || this.tracking.readyState !== "open" || this.tracking.bufferedAmount > 0 || (limit && limit < 5)) return;
    const now = performance.now(), bytes = this.session.requestClock(now);
    if (!bytes) return;
    try {
      this.tracking.send(bytes);
      recording.packet(this.recordingId, "sent", "unreliable", bytes, now);
      profiler.transfer("sent", bytes.length, now);
    } catch { /* Lost probes expire; channel callbacks handle connection failure. */ }
  }
  publish(request: Request) {
    let bytes: Uint8Array;
    try {
      const previous = [...this.session.active.values()].find(s => s.request.group === request.group);
      if ([...this.session.pending.values()].some(r => r.group === request.group)) throw new Error("A publication request is already pending");
      const oldSchedule = previous?.request.schedule, schedule = request.schedule;
      const scheduleChanged = oldSchedule?.kind !== schedule.kind || (schedule.kind === "periodic" && oldSchedule?.kind === "periodic"
        && (oldSchedule.interval !== schedule.interval || oldSchedule.phase !== schedule.phase || oldSchedule.consumptionDelay !== schedule.consumptionDelay));
      if (previous && previous.request.delivery === request.delivery && JSON.stringify(previous.request.samples) === JSON.stringify(request.samples)
          && scheduleChanged) {
        bytes = this.session.changeSchedule(previous.request.id, request.schedule);
        if (this.send(bytes)) { this.state.detail = `Subscription ${previous.request.id} schedule updated`; this.emit(); }
        return;
      }
      request = { ...request, id: this.session.allocateId() };
      bytes = this.session.request(request);
      if (previous) this.replacements.set(request.id, previous.request.id);
    }
    catch (error) { this.state.detail = `Selection not sent: ${String(error)}. Choose a smaller or supported selection.`; this.emit(); return; }
    if (this.send(bytes)) { this.state.detail = `Subscription ${request.id} requested…`; this.emit(); }
  }
  unsubscribe(id: number) {
    let bytes: Uint8Array;
    try { bytes = this.session.stop(id); }
    catch (error) { this.state.detail = String(error); this.emit(); return; }
    if (this.send(bytes)) { this.state.detail = `Stopping subscription ${id}…`; this.emit(); }
  }

  private emit() {
    this.refreshFreshness();
    const state = `${this.state.status}: ${this.state.detail}`;
    if (state !== this.recordedState) {
      recording.add({ type: "connection-state", connection: this.recordingId, status: this.state.status, detail: this.state.detail });
      this.recordedState = state;
    }
    if (!this.stopped) this.update(this.state);
  }
  private refreshFreshness() {
    const freshness = this.session.freshness(performance.now());
    this.state.freshness = freshness;
    const key = `${freshness.status}:${freshness.worst?.id}:${freshness.worst?.generation}`;
    if (key !== this.recordedFreshness) {
      recording.add({ type: "freshness-state", connection: this.recordingId, ...freshness });
      this.recordedFreshness = key;
    }
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
    clearInterval(this.clockTimer);
    clearInterval(this.freshnessTimer);
    this.pc.close();
    delete this.state.session;
    this.session.retire();
    this.refreshFreshness();
    this.state.status = "Disconnected";
    this.state.detail = "Disconnected. Reconnect to inspect the device.";
    this.state.control = "closed";
    this.state.tracking = "closed";
    this.update(this.state);
  }
}
