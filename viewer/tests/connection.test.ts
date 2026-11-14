import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection } from "../src/connection";
import { preferredFormat, subscribe } from "../src/protocol";
import type { Capabilities } from "../src/protocol";
import { recording } from "../src/recording";
import type { RecordingEvent } from "../src/recording";
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
const request = {id:1,group:0,delivery: 1, rate:60,samples:[{descriptor:0,format:11,space:2}]};
test("valid f64-only poses use an advertised default; oversized selections leave discovery usable", () => {
  const original = globalThis.RTCPeerConnection;
  Object.assign(globalThis,{RTCPeerConnection:Peer});
  try {
    const c=caps(); assert.equal(preferredFormat(c.descriptors[0]),11);
    const first=connection(c); first.publish({...request,samples:[{...request.samples[0],format:preferredFormat(c.descriptors[0])}]});
    assert.equal(first.state.status,"Connected");assert.equal(first.session.pending.size,1);first.close();
    const many=caps(); many.descriptors=Array.from({length:400},(_,i)=>({...many.descriptors[0],id:String(i)}));
    const large=connection(many);large.publish({...request,samples:many.descriptors.map((d,descriptor)=>({descriptor,format:preferredFormat(d),space:2}))});
    assert.equal(large.state.status,"Connected");assert.equal(large.session.pending.size,0);assert.equal(Peer.latest.closed,false);assert.match(large.state.detail,/smaller/);
    large.publish(request);assert.equal(large.session.pending.size,1);large.close();
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
    const c=connection();c.publish(request);c.session.receive({tag:5,id:1,generation:1});Peer.latest.control.throwing=true;c.unsubscribe(1);
    assert.equal(c.state.status,"Error");assert.equal(c.session.active.size,0);assert.equal(c.session.stopping.size,0);
  } finally {Object.assign(globalThis,{RTCPeerConnection:original});}
});

test("control records fragment at the negotiated limit; partial send failures retire the session", () => {
  const original=globalThis.RTCPeerConnection;Object.assign(globalThis,{RTCPeerConnection:Peer});
  try {
    const caps: Capabilities={ skeletons: [], groups:[60],descriptors:Array.from({length:40},(_,i)=>({id:String(i),name:"",description:"",kind:2,formats:[1],spaces:[],group:0}))};
    const request={id:1,group:0,delivery: 1, rate:60,samples:caps.descriptors.map((_,descriptor)=>({descriptor,format:1,space:0}))};
    const c=connection(caps);Peer.latest.sctp.maxMessageSize=128;c.publish(request);
    assert.equal(Peer.latest.control.sent.length,3);assert.ok(Peer.latest.control.sent.every(b=>b.length<=128));
    assert.deepEqual(new Uint8Array(Buffer.concat(Peer.latest.control.sent)),subscribe(request));assert.equal(c.state.status,"Connected");c.close();
    const failed=connection(caps);Peer.latest.sctp.maxMessageSize=128;Peer.latest.control.failAfter=1;failed.publish(request);
    assert.equal(Peer.latest.control.sent.length,1);assert.equal(failed.state.status,"Error");assert.equal(failed.session.pending.size,0);
  }finally{Object.assign(globalThis,{RTCPeerConnection:original});}
});

test("freshness observers and recordings change during silence without disconnecting", async context => {
  context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 1000;
  context.mock.method(performance, "now", () => now);
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ type: "answer", sdp: "test" })));
  const recorded: string[] = [];
  context.mock.method(recording, "add", (event: RecordingEvent) => { if (event.type === "freshness-state") recorded.push(String(event.status)); });
  const original = globalThis.RTCPeerConnection;
  Object.assign(globalThis, { RTCPeerConnection: Peer });
  const updates: string[] = [], c = new Connection(state => updates.push(state.freshness.status));
  try {
    await c.connect();
    c.session.receive({ tag: 2, version: 1 }); c.session.receive({ tag: 3, capabilities: caps() });
    Peer.latest.control.onmessage!({ data: new ArrayBuffer(0) });
    c.session.receive({ tag: 5, id: 1, generation: 1 });
    c.session.clock = { offset: 0n, delay: 20_000_000n, at: now };
    const bytes = new Uint8Array(74), view = new DataView(bytes.buffer);
    bytes[0] = 9; view.setUint32(1, 1, true); view.setUint32(5, 1, true);
    view.setBigUint64(9, 990_000_000n, true); bytes[17] = 1; view.setFloat64(66, 1, true);
    Peer.latest.tracking.onmessage!({ data: bytes.buffer });
    assert.equal(c.state.freshness.status, "Fresh");
    now = 1044; context.mock.timers.tick(48);
    assert.equal(c.state.status, "Connected"); assert.equal(c.state.freshness.status, "Late");
    assert.ok(updates.includes("Late")); assert.ok(recorded.includes("Late"));
    view.setBigUint64(9, 1_034_000_000n, true);
    Peer.latest.tracking.onmessage!({ data: bytes.buffer });
    assert.equal(c.state.freshness.status, "Fresh");
    c.close();
    assert.equal(c.state.freshness.status, "Inactive");
    const count = updates.length;
    now += 500; context.mock.timers.tick(500);
    assert.equal(updates.length, count, "Closing cancels freshness polling");
  } finally { c.close(); Object.assign(globalThis, { RTCPeerConnection: original }); }
});
