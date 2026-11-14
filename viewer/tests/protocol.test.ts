import { periodic, NON_MAX } from "../src/protocol";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ControlDecoder, restGroup, compatible, counterDelta, decodeTracking, updateSchedule, validateSchedule, offer, subscribe, unsubscribe, validateCapabilities, validateRequest } from "../src/protocol";
import type { Capabilities, Request } from "../src/protocol";
import { Session } from "../src/session";
import { spatialFrames, valueText } from "../src/tracking-view";
const spec = JSON.parse(readFileSync(new URL("../../protocol/testdata/specification-v1.json", import.meta.url), "utf8"));
const wire = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const specCaps = (value: any): Capabilities => ({ groups: value.sample_groups.map((g: any) => g.max_sample_rate_hz), skeletons: value.skeletons, descriptors: value.sample_descriptors.map((d: any) => ({ ...d, formats: d.supported_formats, spaces: d.supported_spaces ?? [] })) });
const specSchedule = (s: any): import("../src/protocol").Schedule => s.kind === "OnChange" ? {kind:"onChange"} : {kind:"periodic",interval:BigInt(s.interval),phase:BigInt(s.phase),consumptionDelay:BigInt(s.consumption_delay)};
const specRequest = (r: any): Request => ({id:r.subscription_id, group:r.selection.group, delivery:r.channel, schedule:specSchedule(r.schedule), samples:r.selection.samples.map((s: any)=>({descriptor:s.descriptor,format:s.format,space:s.reference_space ?? 0}))});
const hex = (name: string) => wire([...spec.records, ...spec.publications].find(v => v.name === name).hex);
const c: Capabilities = { skeletons: [], groups: [200], descriptors: [2,3,4,8].map((kind, i) => ({ id: String(i), name: "", description: "", kind, formats: [[1],[2],[2],[12]][i], group: 0, spaces: [] })) };
const request: Request = { id: 7, group: 0, delivery: 1, schedule:periodic(60,5_000_000n,25_000_000n), samples: [1,2,12].map((format, descriptor) => ({ descriptor: descriptor === 2 ? 3 : descriptor, format, space: 0 })) };
function session() { const s = new Session(); s.receive({tag:2,version:1}); s.receive({tag:3,capabilities:structuredClone(c)}); return s; }
function accepted(s = session()) { s.request(request); s.receive({tag:5,id:7}); return s; }
function packetAt(bytes: Uint8Array, time: bigint, id = 7) { const out = bytes.slice(), v = new DataView(out.buffer); v.setBigUint64(4,time,true); v.setUint32(0,id,true); return out; }
function uint(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function string(s: string) { const b = Buffer.from(s); return Buffer.concat([uint(b.length),b]); }
function frame(body: Uint8Array) { return Buffer.concat([uint(body.length),body]); }

test("clock probes preserve u64 precision, accept reordered responses, expire and reset", () => {
  const s = session();
  const response = (id: number, t2: bigint, t3: bigint) => {
    const b = Buffer.alloc(21); b[0] = 11; b.writeUInt32LE(id,1); b.writeBigUInt64LE(t2,5); b.writeBigUInt64LE(t3,13); return b;
  };
  const base = 9007199254740993n;
  assert.deepEqual(s.requestClock(1), Uint8Array.of(10,0,0,0,0));
  s.unreliable(response(0,base+200_000n,base+300_000n),1.3);
  assert.equal(s.clock?.delay,200_000n); assert.equal(s.clock?.offset,base-900_000n);
  assert.ok(Math.abs(s.sampleAge(base+150_000n,1.3)!-0.25)<1e-9);
  const clock=s.clock; s.unreliable(response(0,0n,0n),2); assert.equal(s.clock,clock);
  s.requestClock(3); s.requestClock(4);
  s.unreliable(response(2,base+3_100_000n,base+3_100_000n),4.1);
  s.unreliable(response(1,base+2_100_000n,base+2_100_000n),4.2);
  assert.equal(s.clock?.delay,100_000n);
  s.requestClock(5); s.unreliable(response(3,20n,10n),6); assert.equal(s.clock?.delay,100_000n);
  assert.equal(s.sampleAge(base,31_000),undefined);
  s.retire(); assert.equal(s.clock,undefined); assert.equal(s.requestClock(32_000),undefined);
});

test("network latency uses a two-second median of corrected probe round trips independently of sample age", () => {
  const s = session(), base = 9007199254740993n;
  const probe = (sent: number, received: number, serverReceive: number, serverSend: number) => {
    const request = s.requestClock(sent)!, response = Buffer.alloc(21);
    response[0] = 11; response.set(request.subarray(1),1);
    response.writeBigUInt64LE(base + BigInt(serverReceive) * 1_000_000n,5);
    response.writeBigUInt64LE(base + BigInt(serverSend) * 1_000_000n,13);
    s.unreliable(response,received);
  };
  assert.equal(s.networkLatency(0),undefined);
  assert.equal(s.latestNetworkLatency(0),undefined);
  // 100 ms elapsed, minus 80 ms on the device, gives 10 ms estimated one way.
  probe(0,100,10,90);
  assert.equal(s.networkLatency(100),10);
  assert.equal(s.networkLatency(1000),10);
  assert.equal(s.sampleAge(base,100),100);
  assert.equal(s.sampleAge(base,1000),1000);
  probe(1000,1040,1010,1030);
  probe(1500,1700,1600,1600); // A 100 ms outlier must not become the median.
  assert.equal(s.networkLatency(1700),10);
  assert.equal(s.latestNetworkLatency(1700),100, "The latest probe remains visible alongside the median");
  assert.equal(s.networkLatency(2099),10);
  assert.equal(s.networkLatency(2100),55); // The oldest 10 ms probe expires exactly at 2 s.
  probe(2200,2240,2210,2230);
  assert.equal(s.networkLatency(2240),10);
  assert.equal(s.networkLatency(3040),55);
  assert.equal(s.networkLatency(3700),10);
  assert.equal(s.networkLatency(4240),undefined);
  assert.equal(s.latestNetworkLatency(4240),undefined, "Missing probes create a graph gap rather than a zero");
  assert.equal(s.active.size,0, "Latency does not require a publication subscription");
  probe(5000,5040,5010,5030);
  s.retire(); assert.equal(s.networkLatency(5040),undefined);
  assert.equal(s.latestNetworkLatency(5040),undefined);
});

test("sample age compares photon time with the actual prediction target and retains its sign", () => {
  const s = session(), timestamp = 9007199254740993n;
  s.clock = { offset: timestamp - 1_000_000_000n, delay: 10_000_000n, at: 1000 };
  assert.equal(s.sampleAge(timestamp+25_000_000n,1005,20),0, "5 ms travel plus 20 ms display delay matches 25 ms prediction");
  assert.equal(s.sampleAge(timestamp+25_000_000n,1007,20),2);
  assert.equal(s.sampleAge(timestamp+25_000_000n,1002,20),-3, "A prediction ahead of photon time must not be clamped to zero");
  assert.equal(s.sampleAge(timestamp+25_000_000n,1005,30),10, "Changing the display assumption changes age, not the fixed horizon");
  assert.equal(s.sampleAge(timestamp+25_000_000n,1005,0),-20);
  assert.equal(s.sampleAge(timestamp+25_000_000n,31_001,20),undefined);
  s.retire(); assert.equal(s.sampleAge(timestamp+25_000_000n,1005,20),undefined);
});

test("publication delivery is enforced across tagged datagrams and segmented reliable records", () => {
  const s=session(); s.request({...request,delivery:2}); s.receive({tag:5,id:7});
  const bytes=hex("available"), datagram=Buffer.concat([Buffer.from([9]),bytes]), record=frame(datagram);
  assert.equal(s.unreliable(datagram,0),null);
  assert.equal(s.control(record.subarray(0,10),1).length,0); assert.equal(s.control(record.subarray(10),2).length,1);
  assert.deepEqual(s.active.get(7)?.packet?.values,[true,254,128/255]);
  const u=accepted(); assert.equal(u.control(record,0).length,0); assert.ok(u.unreliable(datagram,1));
  for(const bad of [bytes,Buffer.from([0]),Buffer.from([10,0,0,0,0]),Buffer.from([11])]) assert.equal(u.unreliable(bad,2),null);
});

test("new semantic references and reserved indices are validated after discovery", () => {
  const c=specCaps(spec.capabilities.device); validateCapabilities(c);
  for(const mutate of [
    (c: Capabilities)=>c.descriptors[0].press_count_sample=0xffffffff,
    (c: Capabilities)=>c.descriptors[0].press_count_sample=3,
    (c: Capabilities)=>c.descriptors[14].revision_of=0xffffffff,
    (c: Capabilities)=>c.skeletons[0].joints[0].parent=0xffffffff,
    (c: Capabilities)=>c.skeletons[0].joints[0].pose_sample=0,
  ]) { const bad=structuredClone(c); mutate(bad); assert.throws(()=>validateCapabilities(bad)); }
  assert.throws(()=>validateRequest(c,{...specRequest(spec.requests.inputs.value),delivery:0}));
  for(const kind of [11,12,13,14,15,16]) for(let format=1;format<=15;format++) {
    const d={id:"new",name:"",description:"",kind,group:0,formats:[format],spaces:[],...(kind===11?{revision_of:0}:{})};
    const caps={groups:[60],descriptors:[d],skeletons:[]};
    if(compatible(kind,format))validateCapabilities(caps);else assert.throws(()=>validateCapabilities(caps));
  }
});
function advertisement(ids = ["a", "\uFEFFa"]) {
  const rate = Buffer.alloc(4); rate.writeFloatLE(200);
  return frame(Buffer.concat([Buffer.from([3]),uint(1),rate,uint(ids.length),...ids.map(id => Buffer.concat([string(id),string("name"),string("description"),Buffer.from([1]),uint(1),Buffer.from([10]),uint(0)])),uint(0)]));
}

test("shared corpus encodes controls and decodes every publication layout", () => {
  for (const entry of spec.records) {
    if (entry.tag === 1) assert.deepEqual(offer(), wire(entry.hex));
    else if (entry.tag === 4) assert.deepEqual(subscribe(specRequest(spec.requests[entry.request].value)), wire(entry.hex));
    else if (entry.tag === 7) assert.deepEqual(unsubscribe(entry.value.subscription_id), wire(entry.hex));
    else if (entry.tag === 12) assert.deepEqual(updateSchedule(entry.value.subscription_id,specSchedule(entry.value.schedule)),wire(entry.hex));
    else if ([2,3,5,6,8,9].includes(entry.tag)) {
      const [message] = new ControlDecoder().feed(wire(entry.hex));
      assert.equal(message.tag, entry.tag);
      if (message.tag === 3) {
        const setup = spec.capabilities[entry.capabilities];
        const expected = specCaps({...setup, skeletons: entry.skeletons ?? setup.skeletons});
        for (const d of expected.descriptors) { delete (d as any).supported_formats; delete (d as any).supported_spaces; }
        assert.deepEqual(message.capabilities, expected);
      } else if (message.tag === 2) assert.equal(message.version, entry.value.selected_version);
      else if (message.tag === 5) assert.equal(message.id, entry.value.subscription_id);
      else if (message.tag === 6 || message.tag === 8) {
        assert.equal(message.id, entry.value.subscription_id);
        assert.equal(message.reason, entry.value.reason ?? undefined);
      }
    }
  }
  for (const entry of spec.publications) for (const name of entry.requests) {
    const setup = spec.requests[name], capabilities = specCaps(spec.capabilities[setup.capabilities]);
    const r = specRequest(setup.value), expected = entry.value;
    validateCapabilities(capabilities); validateRequest(capabilities, r);
    const packet = decodeTracking(wire(entry.hex), capabilities, r);
    assert.equal(packet.id, expected.subscription_id, entry.name);
    assert.equal(packet.timestamp, BigInt(expected.acquired_at), entry.name);
    assert.equal(packet.predictedFor, expected.predicted_for === null ? null : BigInt(expected.predicted_for), entry.name);
    assert.deepEqual(packet.values, expected.values.map((v: unknown, i: number) => Array.isArray(v) && r.samples[i].format === 10 ? v.map(Math.fround) : v), entry.name);
  }
});

test("unavailable, false and zero render distinctly", () => {
  assert.equal(valueText(null),"Unavailable"); assert.equal(valueText(false),"false"); assert.equal(valueText(0),"0");
});
test("segmented/coalesced records, exact UTF-8 identity and malformed control framing", () => {
  const bytes = Buffer.concat([hex("selection"),advertisement(),hex("acceptance")]);
  for (let i=0;i<=bytes.length;i++) {
    const d = new ControlDecoder(), got = [...d.feed(bytes.subarray(0,i)),...d.feed(bytes.subarray(i))];
    assert.equal(got.length,3); assert.equal(got[1].tag,3);
    if (got[1].tag===3) assert.deepEqual(got[1].capabilities.descriptors.map(d=>d.id),["a","\uFEFFa"]);
  }
  for (const bad of [uint(0),uint(0xffffffff),frame(Buffer.from([255])),hex("offer"),frame(Buffer.from([2,1,0,0])),frame(Buffer.from([5,7,0,0,0,0,0,0,0])),advertisement(["a","a"])]) assert.throws(()=>new ControlDecoder().feed(bad));
  const invalidUtf8 = advertisement(["a"]); invalidUtf8[21]=255; assert.throws(()=>new ControlDecoder().feed(invalidUtf8));
  const hugeList=advertisement(); hugeList.set(uint(0xffffffff),13); assert.throws(()=>new ControlDecoder().feed(hugeList));
});
test("every representation preserves its width; snorm accepts both negative endpoints", () => {
  for (const entry of spec.formats) {
    const descriptor = {id:"generic",name:"",description:"",group:0,kind:1,formats:[entry.format],spaces:[]};
    const caps = { skeletons: [], groups:[1],descriptors:[descriptor]}, r = {id:0,group:0,delivery: 1, schedule:periodic(1),samples:[{descriptor:0,format:entry.format,space:0}]};
    const header = Buffer.alloc(21); header.writeBigUInt64LE(NON_MAX,12); header[20]=1;
    const bytes = Buffer.concat([header,Buffer.from(entry.hex,"hex")]);
    const got = decodeTracking(bytes,caps,r).values[0];
    const expected = entry.format===1 ? entry.decoded === "true" : [5,9].includes(entry.format) ? BigInt(entry.decoded) : Number(entry.decoded);
    assert.equal(got,expected,`format ${entry.format}`);
    if ([14,15].includes(entry.format)) { bytes[21]=0; if (entry.format===14) bytes[21]=128; assert.equal(decodeTracking(bytes,caps,r).values[0],-1); }
  }
  assert.equal(counterDelta(1n,254n,2),3n); assert.equal(counterDelta(0n,0xffffffffffffffffn,5),1n);
  for (let kind=1;kind<=10;kind++) for(let format=1;format<=15;format++) {
    const caps = { skeletons: [], groups:[1],descriptors:[{id:"x",name:"",description:"",group:0,kind,formats:[format],spaces:kind===10?[2]:[]}]};
    if(compatible(kind,format)) validateCapabilities(caps); else assert.throws(()=>validateCapabilities(caps));
  }
});
test("loss/reordering, malformed packets and missing counters never corrupt freshness or baselines", () => {
  const s=accepted();
  assert.ok(s.tracking(hex("available"),0));
  const broken=packetAt(hex("missing_boolean"),999999999999n); broken[20]=0x86;
  assert.equal(s.tracking(broken,1),null);
  assert.equal(s.active.get(7)?.packet?.timestamp,1000000000n);
  assert.ok(s.tracking(hex("available"),2), "Equal acquisition timestamps are valid periodic repeats");
  assert.equal(s.tracking(packetAt(hex("available"),999999999n),3),null);
  assert.ok(s.tracking(packetAt(hex("all_missing"),1010000000n),4));
  assert.equal(s.active.get(7)?.counters.get(1),254n);
  assert.ok(s.tracking(hex("missing_boolean"),5));
  assert.equal(s.active.get(7)?.deltas.get(1),3n);
  assert.deepEqual(s.active.get(7)?.packet?.values,[null,1,0]);
  for(const bad of [hex("available").slice(0,-1),Buffer.concat([hex("available"),Buffer.from([0])]),Uint8Array.of(0)]) assert.equal(s.tracking(bad,6),null);
  const padding=packetAt(hex("available"),1020000001n); padding[21]=0x81; assert.equal(s.tracking(padding,7),null);
});
test("fresh ids isolate delayed old-layout datagrams; reliable same-id replacement and rejection preserve ordering", () => {
  const s=session(); s.request(request);
  assert.equal(s.tracking(hex("available"),0),null);
  s.receive({tag:5,id:7}); assert.ok(s.tracking(hex("available"),1));
  const changed={...request,id:8,samples:[request.samples[2]]};
  s.request(changed); s.receive({tag:6,id:8}); assert.equal(s.active.get(7)?.request.samples.length,3);
  s.request(changed); s.receive({tag:5,id:8}); s.stop(7); s.receive({tag:8,id:7,reason:"Unsubscribed"});
  assert.equal(s.tracking(packetAt(hex("available"),2000000000n),2),null);
  const fresh=Buffer.alloc(22);fresh.writeUInt32LE(8);fresh.writeBigUInt64LE(1n,4);fresh.writeBigUInt64LE(NON_MAX,12);fresh[20]=1;
  assert.ok(s.tracking(fresh,3)); assert.equal(s.active.get(8)?.deltas.size,0);
  const reliable={...changed,delivery:2}; s.request(reliable);s.receive({tag:8,id:8,reason:"Replaced"});s.receive({tag:5,id:8});
  assert.ok(s.tracking(fresh,4,2));
  s.receive({tag:8,id:8,reason:"Device lost"}); assert.equal(s.active.size,0);
  assert.equal(session().allocateId(),1);
});
test("wrong direction/phase, invalid capabilities and invalid selections are rejected", () => {
  assert.throws(()=>new Session().receive({tag:5,id:7}));
  assert.throws(()=>new Session().receive({tag:2,version:2}));
  const s=accepted(); assert.throws(()=>s.receive({tag:3,capabilities:c}));
  assert.throws(()=>s.receive({tag:5,id:99}));
  assert.throws(()=>s.receive({tag:6,id:99,reason:"no"}));
  assert.doesNotThrow(()=>s.receive({tag:8,id:99,reason:"Already ended"}));
  for(const r of [{...request,schedule:{kind:"periodic" as const,interval:0n,phase:0n,consumptionDelay:0n}},{...request,schedule:periodic(201)},{...request,samples:[]},{...request,samples:[request.samples[0],request.samples[0]]},{...request,samples:[{descriptor:0,format:1,space:2}]}]) assert.throws(()=>validateRequest(c,r));
});
test("pose tolerance, nonfinite values and zero rotations; individual joints disappear when unavailable/stale", () => {
  for (const format of [10,11]) {
    const caps: Capabilities={ skeletons: [], groups:[60],descriptors:[{id:"/body/FB/7",name:"Head joint",description:"",group:0,kind:10,formats:[format],spaces:[2]}]};
    caps.skeletons = [{joints:[{parent:0,pose_sample:0,rest_pose_sample:0}]}];
    const r={id:1,group:0,delivery: 1, schedule:periodic(60),samples:[{descriptor:0,format,space:2}]};
    const bytes=Buffer.alloc(21+7*(format===10?4:8)); bytes.writeUInt32LE(1);bytes.writeBigUInt64LE(NON_MAX,12);bytes[20]=1;
    const set=(i:number,n:number)=>format===10?bytes.writeFloatLE(n,21+i*4):bytes.writeDoubleLE(n,21+i*8);
    set(0,1);set(1,2);set(2,3);
    const tolerance=format===10?1e-5:1e-12;
    set(6,Math.sqrt(1+tolerance/2)); assert.doesNotThrow(()=>decodeTracking(bytes,caps,r));
    set(6,Math.sqrt(1+tolerance*2)); assert.throws(()=>decodeTracking(bytes,caps,r));
    set(6,0); assert.throws(()=>decodeTracking(bytes,caps,r));
    set(6,1);set(0,NaN); assert.throws(()=>decodeTracking(bytes,caps,r));set(0,1);
    const s=new Session();s.receive({tag:2,version:1});s.receive({tag:3,capabilities:caps});s.request(r);s.receive({tag:5,id:1});s.tracking(bytes,100);
    const view=spatialFrames(s,101);assert.equal(view.body.active,true);assert.equal(view.body.poses.filter(p=>p.flags===3).length,1);assert.deepEqual(view.body.poses[0].position,[1,2,3]);
    assert.equal(spatialFrames(s,1000).body.active,false);
    const missing=bytes.subarray(0,21);missing[20]=0;missing.writeBigUInt64LE(1n,4);s.tracking(missing,1100);assert.equal(spatialFrames(s,1101).body.active,false);
  }
});

test("spatial overlay never combines different reference spaces", () => {
  const caps: Capabilities = { skeletons: [], groups:[60],descriptors:["head","controller"].map(id=>({id,name:id,description:"",group:0,kind:10,formats:[10],spaces:[1,2]}))};
  const s=new Session();s.receive({tag:2,version:1});s.receive({tag:3,capabilities:caps});
  const r={id:1,group:0,delivery: 1, schedule:periodic(60),samples:[{descriptor:0,format:10,space:1},{descriptor:1,format:10,space:2}]};
  s.request(r);s.receive({tag:5,id:1});
  const b=Buffer.alloc(77);b.writeUInt32LE(1);b.writeBigUInt64LE(NON_MAX,12);b[20]=3;b.writeFloatLE(1,45);b.writeFloatLE(1,73);
  assert.ok(s.tracking(b,0));
  const view=spatialFrames(s,1);assert.equal(view.mixedSpaces,true);assert.equal(view.poses.poses.length,0);assert.equal(view.body.active,false);
  assert.equal(s.active.get(1)?.packet?.values.length,2,"Numerical values remain inspectable");
});

test("filtered boolean packing crosses availability bytes and rejects unused high bits", () => {
  const caps: Capabilities={ skeletons: [], groups:[60],descriptors:Array.from({length:9},(_,i)=>({id:String(i),name:"",description:"",kind:2,formats:[1],group:0,spaces:[]}))};
  const r={id:1,group:0,delivery: 1, schedule:periodic(60),samples:caps.descriptors.map((_,descriptor)=>({descriptor,format:1,space:0}))};
  const b=Buffer.alloc(23);b.writeUInt32LE(1);b.writeBigUInt64LE(NON_MAX,12);b.set([0xfe,1,0xaa],20);
  assert.deepEqual(decodeTracking(b,caps,r).values,[null,false,true,false,true,false,true,false,true]);
  b.set([0xfe,0,0x2a],20);assert.equal(decodeTracking(b,caps,r).values[8],null);
  b[22]=0xaa;assert.throws(()=>decodeTracking(b,caps,r));
});

test("only dedicated rest groups default to change-driven reliable publication", () => {
  const c = specCaps(spec.capabilities.device);
  assert.equal(restGroup(c,1),true); assert.equal(restGroup(c,0),false);
  c.descriptors[0].group=1;
  assert.equal(restGroup(c,1),false,"An input sharing the rest group still needs live updates");
});


test("termination crossing unsubscribe is idempotent and preserves other and pending subscriptions", () => {
  const s=accepted(); s.request({...request,id:8}); s.receive({tag:5,id:8});
  s.stop(7); s.receive({tag:8,id:7,reason:"Device stopped"}); s.receive({tag:8,id:7,reason:"Unsubscribed"});
  assert.ok(s.active.has(8)); assert.equal(s.stopping.size,0);
  s.request({...request,id:7}); s.receive({tag:8,id:7,reason:"Already ended"});
  assert.ok(s.pending.has(7)); s.receive({tag:5,id:7}); assert.ok(s.active.has(7));
});

test("live schedules retain selection and packet state, support both channels, and validate NonMax times", () => {
  for (const delivery of [1,2]) {
    const s=session(); s.request({...request,delivery}); s.receive({tag:5,id:7});
    assert.ok(s.tracking(hex("available"),0,delivery));
    const sub=s.active.get(7)!,packet=sub.packet,samples=sub.request.samples;
    assert.deepEqual(s.changeSchedule(7,{kind:"onChange"}),wire("060000000c0700000002"));
    assert.equal(sub.packet,packet);assert.equal(sub.request.samples,samples);assert.equal(sub.request.schedule.kind,"onChange");
    const schedule=periodic(50,25_000_000n,9007199254740993n);
    assert.deepEqual(s.changeSchedule(7,schedule),updateSchedule(7,schedule));assert.equal(sub.request.schedule.kind,"periodic");
    for(const field of ["interval","phase","consumptionDelay"] as const)assert.throws(()=>validateSchedule({...periodic(50),[field]:NON_MAX} as any));
    assert.throws(()=>validateSchedule({kind:"periodic",interval:0n,phase:0n,consumptionDelay:0n}));
  }
  const b=hex("available"); new DataView(b.buffer,b.byteOffset,b.byteLength).setBigUint64(4,NON_MAX,true);
  assert.throws(()=>decodeTracking(b,c,request));
  const s=session();s.requestClock(0);const response=Buffer.alloc(21);response[0]=11;response.writeBigUInt64LE(NON_MAX,5);response.writeBigUInt64LE(NON_MAX,13);
  s.unreliable(response,1);assert.equal(s.clock,undefined);
});
