import { periodic, NON_MAX } from "../src/protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection } from "../src/connection";
import { preferredFormat, subscribe } from "../src/protocol";
import type { Capabilities } from "../src/protocol";
import { profiler } from "../src/performance";
class Channel {
  onmessage?: (event: { data: ArrayBuffer }) => void;
  readyState = "open"; bufferedAmount = 0; throwing = false; failAfter = Infinity; sent: Uint8Array[] = [];
  send(bytes: Uint8Array) { if (this.throwing || this.sent.length >= this.failAfter) throw new Error("Send failed"); this.sent.push(bytes); }
}
class Peer {
  static latest: Peer;
  sctp = { maxMessageSize: 65536 };
  control = new Channel(); tracking = new Channel(); closed = false;
  constructor() { Peer.latest = this; }
  createDataChannel(label: string) { return label === "reliable" ? this.control : this.tracking; }
  close() { this.closed = true; }
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "test", toJSON() { return { type: this.type, sdp: this.sdp }; } };
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  addEventListener() {}
  removeEventListener() {}
}
const caps = (): Capabilities => ({ skeletons: [], groups: [60], descriptors: [{id:"pose",name:"pose",description:"",kind:10,formats:[11],spaces:[2],group:0}] });
function connection(c = caps()) {
  const connection = new Connection(() => {});
  connection.session.receive({tag:2,version:1}); connection.session.receive({tag:3,capabilities:c}); connection.state.status = "Connected";
  return connection;
}
const request = {id:1,group:0,delivery: 1, schedule:periodic(60),samples:[{descriptor:0,format:11,space:2}]};
test("connection attempts reset network measurements while preserving render diagnostics", async context => {
  let now = 2000;
  context.mock.method(performance, "now", () => now);
  context.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => url === "/api/health"
    ? new Response("{}") : new Response("Device unavailable", { status: 503 }));
  profiler.start();
  profiler.animationFrame(1950); profiler.animationFrame(1980);
  profiler.end("render", 1990);
  const viewerTimings = () => profiler.snapshot().metrics.filter(m => m.key !== "trackingArrival" && m.key !== "receive");
  const before = viewerTimings();
  const original = globalThis.RTCPeerConnection;
  Object.assign(globalThis, { RTCPeerConnection: Peer });
  try {
    for (let i = 0; i < 3; i++) {
      profiler.transfer("received", 100, 1900); profiler.transfer("sent", 20, 1950);
      profiler.trackingArrival(1, "old", 100, 1900); profiler.trackingArrival(1, "old", 100, 1950);
      profiler.end("receive", 1995); profiler.sampleTransfer(now);
      const c = new Connection(() => {});
      try {
        await c.connect();
        assert.equal(c.state.status, "Error");
        assert.match(c.state.detail, /Signaling failed \(503\)/);
        assert.deepEqual(viewerTimings(), before);
        const snapshot = profiler.snapshot();
        assert.ok(snapshot.transfer.every(m => m.samples.length === 0));
        assert.ok(snapshot.metrics.filter(m => m.key === "trackingArrival" || m.key === "receive").every(m => m.samples.length === 0));
        profiler.sampleTransfer(now);
        assert.ok(profiler.snapshot().transfer.every(m => m.summary?.current === 0), "Traffic counts start fresh too");
        profiler.trackingArrival(1, "old", 100, now);
        assert.deepEqual(profiler.snapshot().metrics.find(m => m.key === "trackingArrival")!.samples, [], "The first arrival has no previous connection baseline");
      } finally { c.close(); }
    }
    now = 2010; profiler.animationFrame(now);
    assert.equal(profiler.snapshot().metrics.find(m => m.key === "frame")!.summary?.current, 30, "The render timing baseline survives connection resets");
  } finally { profiler.stop(); Object.assign(globalThis, { RTCPeerConnection: original }); }
});

test("f64-only poses use an advertised default and publications can exceed the client message bound", () => {
  const original = globalThis.RTCPeerConnection;
  Object.assign(globalThis,{RTCPeerConnection:Peer});
  try {
    const c=caps(); assert.equal(preferredFormat(c.descriptors[0]),11);
    const first=connection(c); first.publish({...request,samples:[{...request.samples[0],format:preferredFormat(c.descriptors[0])}]});
    assert.equal(first.state.status,"Connected");assert.equal(first.session.pending.size,1);first.close();
    const many=caps(); many.descriptors=Array.from({length:1200},(_,i)=>({...many.descriptors[0],id:String(i)}));
    const large=connection(many);large.publish({...request,samples:many.descriptors.map((d,descriptor)=>({descriptor,format:preferredFormat(d),space:2}))});
    assert.equal(large.state.status,"Connected");assert.equal(large.session.pending.size,1);assert.equal(Peer.latest.closed,false);
    large.close();
  } finally { Object.assign(globalThis,{RTCPeerConnection:original}); }
});
test("reliable send failures retire prepared subscription and unsubscription state", () => {
  const original = globalThis.RTCPeerConnection;
  Object.assign(globalThis,{RTCPeerConnection:Peer});
  try {
    for(const failure of ["closed","buffered","throw"]){
      const c=connection();
      if(failure==="closed")Peer.latest.control.readyState="closed";
      if(failure==="buffered")Peer.latest.control.bufferedAmount=1048576;
      if(failure==="throw")Peer.latest.control.throwing=true;
      c.publish(request);assert.equal(c.state.status,"Error");assert.equal(c.state.session,undefined);assert.equal(c.session.capabilities,undefined);assert.equal(c.session.phase,"closed");assert.equal(c.session.pending.size,0);assert.equal(Peer.latest.closed,true);
    }
    const c=connection();c.publish(request);c.session.receive({tag:5,id:1});Peer.latest.control.throwing=true;c.unsubscribe(1);
    assert.equal(c.state.status,"Error");assert.equal(c.session.active.size,0);assert.equal(c.session.stopping.size,0);
  } finally {Object.assign(globalThis,{RTCPeerConnection:original});}
});

test("control messages send whole and reject the smaller negotiated limit", () => {
  const original=globalThis.RTCPeerConnection;Object.assign(globalThis,{RTCPeerConnection:Peer});
  try {
    const caps: Capabilities={skeletons:[],groups:[60],descriptors:Array.from({length:40},(_,i)=>({id:String(i),name:"",description:"",kind:2,formats:[1],spaces:[],group:0}))};
    const request={id:1,group:0,delivery:1,schedule:periodic(60),samples:caps.descriptors.map((_,descriptor)=>({descriptor,format:1,space:0}))};
    const c=connection(caps);c.publish(request);
    assert.equal(Peer.latest.control.sent.length,1);assert.deepEqual(Peer.latest.control.sent[0],subscribe(request));c.close();
    const limited=connection(caps);Peer.latest.sctp.maxMessageSize=128;limited.publish(request);
    assert.equal(Peer.latest.control.sent.length,0);assert.equal(limited.state.status,"Error");assert.equal(limited.session.pending.size,0);
  }finally{Object.assign(globalThis,{RTCPeerConnection:original});}
});

test("freshness observers change during silence without disconnecting", async context => {
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 1000;
  context.mock.method(performance, "now", () => now);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ type: "answer", sdp: "test" })));
  const original = globalThis.RTCPeerConnection;
  Object.assign(globalThis, { RTCPeerConnection: Peer });
  const updates: string[] = [], c = new Connection(state => updates.push(state.freshness.status));
  try {
    await c.connect();
    c.session.receive({ tag: 2, version: 1 }); c.session.receive({ tag: 3, capabilities: caps() });
    Peer.latest.control.onmessage!({ data: Uint8Array.of(8,99,0,0,0,1,0,0,0,97).buffer });
    c.session.receive({ tag: 5, id: 1 });
    c.session.clock = { offset: 0n, delay: 20_000_000n, at: now };
    const bytes = new Uint8Array(77), view = new DataView(bytes.buffer);
    bytes[0] = 9; view.setUint32(1, 1, true); view.setBigUint64(13, NON_MAX, true);
    view.setBigUint64(5, 990_000_000n, true); view.setFloat64(69, 1, true);
    Peer.latest.tracking.onmessage!({ data: bytes.buffer });
    assert.equal(c.state.freshness.status, "Fresh");
    now = 1044; context.mock.timers.tick(48);
    assert.equal(c.state.status, "Connected"); assert.equal(c.state.freshness.status, "Late");
    assert.ok(updates.includes("Late"));
    view.setBigUint64(5, 1_034_000_000n, true);
    Peer.latest.tracking.onmessage!({ data: bytes.buffer });
    assert.equal(c.state.freshness.status, "Fresh");
    c.close();
    assert.equal(c.state.freshness.status, "Inactive");
    const count = updates.length;
    now += 500; context.mock.timers.tick(500);
    assert.equal(updates.length, count, "Closing cancels freshness polling");
  } finally { c.close(); Object.assign(globalThis, { RTCPeerConnection: original }); }
});
