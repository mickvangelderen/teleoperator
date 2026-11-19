import { phoneControlsOnly } from "./phone-controls";
import { Session } from "./session";
import { restGroup, timing, MAX_CLIENT_MESSAGE } from "./protocol";
import { defaultBundles } from "./default-bundles";
import type { Request } from "./protocol";
import { profiler } from "./performance";
import type { Freshness } from "./freshness";
import type { Recorder } from "./recording";
import { PublicationTiming, scheduleNeedsUpdate, SCHEDULE_UPDATE_INTERVAL_MS } from "./publication-timing";

export type State = {
  status: "Disconnected" | "Connecting" | "Connected" | "Error";
  detail: string;
  control: string;
  tracking: string;
  source: string;
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

export const MAX_UNRELIABLE_BACKLOG = 4096; // Small ACK/probe backlog; never queue protocol messages locally.
export type PublishResult = { kind: "pending" | "timing"; id: number } | { kind: "error"; reason: string };
let nextConnectionId = 1;
export class Connection {
  private readonly id = nextConnectionId++;
  readonly state = initialState();
  readonly session = new Session();
  private offered = false;
  private readonly replacements = new Map<number, number>();
  private readonly automatic = new Set<number>();
  private readonly scheduleUpdates = new Map<number, number>();
  private readonly timing = new PublicationTiming();
  private renderToPhotonMs = 0;
  private visible = true;
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
  constructor(private readonly update: (state: State) => void, private readonly recording?: Recorder) { this.state.session = this.session; }

  async connect(address?: string, onHealthy?: (health: unknown) => void) {
    if (this.stopped || this.state.status !== "Disconnected") return;
    profiler.resetConnectionMetrics();
    const headers: Record<string, string> = address ? { "X-Operator-Address": address } : {};
    void fetch("/api/health", { headers, signal: this.abort.signal }).then(r => r.ok ? r.json() : null).then(data => {
      if (this.stopped || !data || typeof data !== "object") return;
      onHealthy?.(data);
      this.state.source = typeof data.source === "string" ? data.source : "unknown";
      this.emit();
    }).catch(() => {});
    this.state.status = "Connecting";
    this.state.detail = "Opening a WebRTC connection…";
    this.emit();
    this.deadline = setTimeout(
      () =>
        this.fail(
          "Connection timed out. Check that the operator is running and reachable.",
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
        const arrivedAt = started ?? performance.now();
        let receivedPublication = false;
        try {
          if (!(event.data instanceof ArrayBuffer)) {
            if (name === "tracking") { this.session.discarded++; return; }
            throw new Error("Expected a binary protocol packet");
          }
          const bytes = new Uint8Array(event.data);
          this.recording?.packet("received", name === "control" ? "reliable" : "unreliable", bytes, arrivedAt);
          profiler.transfer("received", bytes.length, arrivedAt);
          if (name === "control") {
            const packet = this.session.control(bytes, arrivedAt, () => performance.now());
            receivedPublication = packet !== null;
            if (packet) profiler.trackingArrival(packet.id, `${this.id}:${this.session.active.get(packet.id)?.generation}`, bytes.length, arrivedAt);
            for (const [id, previous] of this.replacements) {
              if (this.session.pending.has(id)) continue;
              this.replacements.delete(id);
              if (this.session.active.has(id) && this.session.active.has(previous)) this.send(this.session.stop(previous));
            }
            for (const id of this.automatic) if (!this.session.active.has(id) && !this.session.pending.has(id)) {
              this.automatic.delete(id); this.scheduleUpdates.delete(id);
            }
            this.state.detail = this.session.detail;
            if (this.session.phase === "ready") {
              clearTimeout(this.deadline);
              this.state.status = "Connected";
              if (!this.subscribed) {
                this.subscribed = true;
                this.probeClock();
                this.clockTimer = setInterval(() => this.probeClock(), 250);
                this.freshnessTimer = setInterval(() => this.emit(), 16);
                const c = this.session.capabilities!;
                c.groups.forEach((max, group) => {
                  const rest = restGroup(c, group);
                  const bundles = defaultBundles(c, group, rest);
                  if (bundles.length === 1 && phoneControlsOnly(bundles[0].map(s => c.descriptors[s.descriptor]))) {
                    bundles.unshift([]); // Phone controls publish on change, with no continuous samples.
                  }
                  if (!this.stopped && bundles.some(b => b.length)) {
                    this.publish({ id: group + 1, group, delivery: rest ? 2 : 1, ...timing(Math.min(max, 60)),
                      sequenceNumberFormat: bundles.length > 1 ? 2 : null, bundles }, !rest);
                  }
                });
              }
            }
          } else {
            const packet = this.session.unreliable(bytes, arrivedAt, () => performance.now());
            receivedPublication = packet !== null;
            if (packet) profiler.trackingArrival(packet.id, `${this.id}:${this.session.active.get(packet.id)?.generation}`, bytes.length, arrivedAt);
          }
          for (const ack of this.session.takeAcknowledgments()) this.sendUnreliable(ack);
          this.emit();
        } catch (error) {
          if (name === "control") this.fail(error instanceof Error ? error.message : "Invalid control message");
          else { this.session.discarded++; this.emit(); }
        } finally {
          if (receivedPublication) this.timing.received(performance.now() - arrivedAt, performance.now());
          profiler.end("receive", started);
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
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(this.pc.localDescription),
        signal: this.abort.signal,
      });
      if (!response.ok) {
        const plainText = response.headers.get("content-type")?.split(";")[0] === "text/plain";
        const reason = plainText ? (await response.text()).trim().slice(0, 512) : "";
        throw new Error(`Signaling failed (${response.status}). ${reason || "Check the operator address and port."}`);
      }
      const text = await response.text();
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
      const limit = negotiated && Number.isFinite(negotiated) ? Math.min(MAX_CLIENT_MESSAGE, Math.floor(negotiated)) : MAX_CLIENT_MESSAGE;
      if (limit < 1 || bytes.length > limit) throw new Error("Message exceeds the data channel limit");
      this.control.send(bytes as Uint8Array<ArrayBuffer>);
      const now = performance.now();
      this.recording?.packet("sent", "reliable", bytes, now);
      profiler.transfer("sent", bytes.length, now);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Control send failed");
      return false;
    }
  }
  private sendUnreliable(bytes: Uint8Array, now = performance.now()) {
    const limit = this.pc.sctp?.maxMessageSize;
    if (this.stopped || this.tracking.readyState !== "open" || this.tracking.bufferedAmount + bytes.length > MAX_UNRELIABLE_BACKLOG || (limit && bytes.length > limit)) return;
    try {
      this.tracking.send(bytes as Uint8Array<ArrayBuffer>);
      this.recording?.packet("sent", "unreliable", bytes, now);
      profiler.transfer("sent", bytes.length, now);
    } catch { /* Unsent ACKs are dropped; a later pending publication repairs loss. */ }
  }
  private probeClock() {
    if (this.stopped || this.tracking.readyState !== "open" || this.tracking.bufferedAmount > 0) return;
    const now = performance.now(), bytes = this.session.requestClock(now);
    if (bytes) this.sendUnreliable(bytes, now);
  }
  isAutomatic(id: number) { return this.automatic.has(id); }

  // Called at the point the viewer consumes the latest samples for a frame.
  frame(frameTime: number, now: number, renderToPhotonMs: number) {
    if (this.stopped || !this.visible) return;
    this.renderToPhotonMs = renderToPhotonMs;
    this.session.consume(now, renderToPhotonMs);
    this.refreshFreshness(now);
    this.timing.frame(frameTime, now);
    if (this.session.phase !== "ready") return;
    for (const sub of this.session.active.values()) {
      const { id, group } = sub.request;
      const schedule = sub.request;
      if (!this.automatic.has(id) || this.session.stopping.has(id)
        || [...this.replacements].some(([pending, previous]) => previous === id && this.session.pending.has(pending))
        || now - (this.scheduleUpdates.get(id) ?? -Infinity) < SCHEDULE_UPDATE_INTERVAL_MS) continue;
      const next = this.timing.schedule(schedule, now, renderToPhotonMs, this.session.clockEstimate(now), this.session.networkLatency(now), this.session.capabilities!.groups[group], sub.controllerTiming?.deliveryMs());
      if (!next) continue;
      this.scheduleUpdates.set(id, now);
      if (!scheduleNeedsUpdate(schedule, next)) continue;
      if (!this.send(this.session.changeSchedule(id, next))) return;
    }
  }

  visibilityChanged(now: number, visible: boolean) {
    this.visible = visible;
    this.timing.reset(now);
    if (visible && this.session.phase === "ready") this.probeClock();
  }

  publish(request: Request, automaticTiming = false, previousId?: number): PublishResult {
    let bytes: Uint8Array;
    try {
      const previous = previousId === undefined ? undefined : this.session.active.get(previousId);
      if (previousId !== undefined && (!previous || previous.request.group !== request.group)) throw new Error("The subscription to replace is no longer active");
      if (previousId !== undefined && [...this.replacements].some(([id, old]) => old === previousId && this.session.pending.has(id))) throw new Error("A replacement is already pending for this subscription");
      const now = performance.now();
      if (automaticTiming) request = { ...request, ...this.timing.schedule(request, now, this.renderToPhotonMs, this.session.clockEstimate(now), this.session.networkLatency(now), this.session.capabilities?.groups[request.group]) };
      if (previous && previous.request.delivery === request.delivery && previous.request.sequenceNumberFormat === request.sequenceNumberFormat
        && JSON.stringify(previous.request.bundles) === JSON.stringify(request.bundles)) {
        bytes = this.session.changeSchedule(previous.request.id, request);
        if (!this.send(bytes)) return { kind: "error", reason: this.state.detail };
        if (automaticTiming) this.automatic.add(previous.request.id); else this.automatic.delete(previous.request.id);
        this.scheduleUpdates.delete(previous.request.id);
        this.state.detail = `Subscription ${previous.request.id} timing sent; no confirmation`; this.emit();
        return { kind: "timing", id: previous.request.id };
      }
      request = { ...request, id: this.session.allocateId() };
      bytes = this.session.request(request);
      if (automaticTiming) this.automatic.add(request.id);
      if (previous) this.replacements.set(request.id, previous.request.id);
    }
    catch (error) { this.state.detail = `Selection not sent: ${String(error)}`; this.emit(); return { kind: "error", reason: this.state.detail }; }
    if (!this.send(bytes)) return { kind: "error", reason: this.state.detail };
    this.state.detail = `Subscription ${request.id} requested…`; this.emit();
    return { kind: "pending", id: request.id };
  }
  unsubscribe(id: number) {
    let bytes: Uint8Array;
    try { bytes = this.session.stop(id); }
    catch (error) { this.state.detail = String(error); this.emit(); return; }
    if (this.send(bytes)) { this.automatic.delete(id); this.scheduleUpdates.delete(id); this.state.detail = `Stopping subscription ${id}…`; this.emit(); }
  }

  private emit() {
    this.refreshFreshness();
    if (!this.stopped) this.update(this.state);
  }
  private refreshFreshness(now = performance.now()) {
    this.state.freshness = this.session.freshness(now);
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
    void this.recording?.stop();
    this.abort.abort();
    clearTimeout(this.deadline);
    clearInterval(this.clockTimer);
    clearInterval(this.freshnessTimer);
    this.pc.close();
    this.automatic.clear(); this.scheduleUpdates.clear(); this.replacements.clear();
    delete this.state.session;
    this.session.retire();
    this.refreshFreshness();
    this.state.status = "Disconnected";
    this.state.detail = "Disconnected. Reconnect to inspect the device.";
    this.state.source = "unknown";
    this.state.control = "closed";
    this.state.tracking = "closed";
    this.update(this.state);
  }
}
