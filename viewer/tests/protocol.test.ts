import { periodic, NON_MAX } from "../src/protocol";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeServer, MAX_SERVER_MESSAGE, restGroup, compatible, counterDelta, decodeTracking, updateSchedule, validateSchedule, offer, subscribe, unsubscribe, validateCapabilities, validateRequest } from "../src/protocol";
import type { Capabilities, Request } from "../src/protocol";
import { Session, selectedPacket } from "../src/session";
import { currentValues, spatialFrames, valueText } from "../src/tracking-view";
const spec = JSON.parse(readFileSync(new URL("../../protocol/testdata/specification-v1.json", import.meta.url), "utf8"));
const wire = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const specCaps = (value: any): Capabilities => ({ groups: value.sample_groups.map((g: any) => g.max_sample_rate_hz), skeletons: value.skeletons, descriptors: value.sample_descriptors.map((d: any) => ({ ...d, formats: d.supported_formats, spaces: d.supported_spaces ?? [] })) });
const specSchedule = (s: any): import("../src/protocol").Schedule => s.kind === "OnChange" ? {kind:"onChange"} : {kind:"periodic",interval:BigInt(s.interval),phase:BigInt(s.phase),consumptionDelay:BigInt(s.consumption_delay)};
const specRequest = (r: any): Request => ({id:r.subscription_id, group:r.selection.group, delivery:r.channel, schedule:specSchedule(r.schedule), samples:r.selection.samples.map((s: any)=>({descriptor:s.descriptor,format:s.format,space:s.reference_space ?? 0}))});
const hex = (name: string) => wire(spec.records.find((v: any) => v.name === name).hex);
const publication = (name: string) => wire(spec.publications.find((v: any) => v.name === name).hex).subarray(1);
const c: Capabilities = { skeletons: [], groups: [200], descriptors: [2,3,4,8].map((kind, i) => ({ id: String(i), name: "", description: "", kind, formats: [[1],[2],[2],[12]][i], group: 0, spaces: [] })) };
const request: Request = { id: 7, group: 0, delivery: 1, schedule:periodic(60,5_000_000n,25_000_000n), samples: [1,2,12].map((format, descriptor) => ({ descriptor: descriptor === 2 ? 3 : descriptor, format, space: 0 })) };
function session() { const s = new Session(); s.receive({tag:2,version:1}); s.receive({tag:3,capabilities:structuredClone(c)}); return s; }
function accepted(s = session()) { s.request(request); s.receive({tag:5,id:7}); return s; }
function packetAt(bytes: Uint8Array, time: bigint, id = 7) { const out = bytes.slice(), v = new DataView(out.buffer); v.setBigUint64(4,time,true); v.setUint32(0,id,true); return out; }
function uint(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function string(s: string) { const b = Buffer.from(s); return Buffer.concat([uint(b.length),b]); }


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

test("publication delivery is enforced with one shared message envelope", () => {
  const s=session(); s.request({...request,delivery:2}); s.receive({tag:5,id:7});
  const message=wire(spec.publications.find((v: any)=>v.name==="available").hex);
  assert.equal(s.unreliable(message,0),null);
  assert.ok(s.control(message,1));
  assert.deepEqual(s.active.get(7)?.packet?.values,[true,254,128/255]);
  const u=accepted(); assert.equal(u.control(message,0),null); assert.ok(u.unreliable(message,1));
  for(const bad of [publication("available"),Buffer.from([0]),Buffer.from([10,0,0,0,0]),Buffer.from([11])]) assert.equal(u.unreliable(bad,2),null);
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
  return Buffer.concat([Buffer.from([3]),uint(1),rate,uint(ids.length),...ids.map(id => Buffer.concat([string(id),string("name"),string("description"),Buffer.from([1]),uint(1),Buffer.from([10]),uint(0)])),uint(0)]);
}

test("shared corpus encodes controls and decodes every publication layout", () => {
  for (const entry of spec.records) {
    if (entry.tag === 1) assert.deepEqual(offer(), wire(entry.hex));
    else if (entry.tag === 4) assert.deepEqual(subscribe(specRequest(spec.requests[entry.request].value)), wire(entry.hex));
    else if (entry.tag === 7) assert.deepEqual(unsubscribe(entry.value.subscription_id), wire(entry.hex));
    else if (entry.tag === 12) assert.deepEqual(updateSchedule(entry.value.subscription_id,specSchedule(entry.value.schedule)),wire(entry.hex));
    else if ([2,3,5,6,8,9].includes(entry.tag)) {
      const message = decodeServer(wire(entry.hex));
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
    const packet = decodeTracking(wire(entry.hex).subarray(1), capabilities, r);
    assert.equal(packet.id, expected.subscription_id, entry.name);
    assert.equal(packet.timestamp, BigInt(expected.acquired_at), entry.name);
    assert.equal(packet.predictedFor, expected.predicted_for === null ? null : BigInt(expected.predicted_for), entry.name);
    assert.deepEqual(packet.values, expected.values.map((v: unknown, i: number) => Array.isArray(v) && r.samples[i].format === 10 ? v.map(Math.fround) : v), entry.name);
  }
});

test("unavailable, false and zero render distinctly", () => {
  assert.equal(valueText(null),"Unavailable"); assert.equal(valueText(false),"false"); assert.equal(valueText(0),"0");
});
test("whole messages preserve exact UTF-8 identity and reject truncation, concatenation and oversize", () => {
  const message=decodeServer(advertisement());
  assert.equal(message.tag,3);
  if(message.tag===3)assert.deepEqual(message.capabilities.descriptors.map(d=>d.id),["a","\uFEFFa"]);
  for(const bytes of [hex("selection"),advertisement(),hex("acceptance")]) {
    for(let i=0;i<bytes.length;i++)assert.throws(()=>decodeServer(bytes.subarray(0,i)));
    assert.throws(()=>decodeServer(Buffer.concat([bytes,bytes])));
  }
  for (const bad of [uint(0),Uint8Array.of(255),hex("offer"),Uint8Array.of(2,1,0,0),Uint8Array.of(5,7,0,0,0,0,0,0,0),advertisement(["a","a"]),new Uint8Array(MAX_SERVER_MESSAGE+1)]) assert.throws(()=>decodeServer(bad));
  const invalidUtf8=advertisement(["a"]);invalidUtf8[17]=255;assert.throws(()=>decodeServer(invalidUtf8));
  const hugeList=advertisement();hugeList.set(uint(0xffffffff),9);assert.throws(()=>decodeServer(hugeList));
});

test("server messages above 64 KiB decode up to the finite receiver bound", () => {
  const id = "x".repeat(MAX_SERVER_MESSAGE - advertisement([""]).length);
  const bytes = advertisement([id]);
  assert.equal(bytes.length, MAX_SERVER_MESSAGE);
  const message = decodeServer(bytes);
  assert.equal(message.tag, 3);
  if (message.tag === 3) assert.equal(message.capabilities.descriptors[0].id, id);
  assert.throws(() => decodeServer(advertisement([id + "x"])), /Message size limit/);
});

test("every representation preserves its width; snorm accepts both negative endpoints", () => {
  for (const entry of spec.formats) {
    const descriptor = {id:"generic",name:"",description:"",group:0,kind:1,formats:[entry.format],spaces:[]};
    const caps = { skeletons: [], groups:[1],descriptors:[descriptor]}, r = {id:0,group:0,delivery: 1, schedule:periodic(1),samples:[{descriptor:0,format:entry.format,space:0}]};
    const header = Buffer.alloc(20); header.writeBigUInt64LE(NON_MAX,12);
    const bytes = Buffer.concat([header,Buffer.from(entry.hex,"hex")]);
    const got = decodeTracking(bytes,caps,r).values[0];
    const expected = entry.format===1 ? entry.decoded === "true" : [5,9].includes(entry.format) ? BigInt(entry.decoded) : Number(entry.decoded);
    assert.equal(got,expected,`format ${entry.format}`);
    if ([14,15].includes(entry.format)) { bytes[20]=0; if (entry.format===14) bytes[20]=128; assert.equal(decodeTracking(bytes,caps,r).values[0],-1); }
  }
  assert.equal(counterDelta(1n,254n,2),3n); assert.equal(counterDelta(0n,0xffffffffffffffffn,5),1n);
  for (let kind=1;kind<=10;kind++) for(let format=1;format<=15;format++) {
    const caps = { skeletons: [], groups:[1],descriptors:[{id:"x",name:"",description:"",group:0,kind,formats:[format],spaces:kind===10?[2]:[]}]};
    if(compatible(kind,format)) validateCapabilities(caps); else assert.throws(()=>validateCapabilities(caps));
  }
});
test("loss/reordering and malformed packets preserve counter baselines; padding is ignored", () => {
  const s=accepted();
  assert.ok(s.tracking(publication("available"),0));
  const broken=packetAt(publication("inactive_inputs"),999999999999n).slice(0,-1);
  assert.equal(s.tracking(broken,1),null);
  assert.equal(s.active.get(7)?.packet?.timestamp,1000000000n);
  assert.ok(s.tracking(publication("available"),2), "Equal acquisition timestamps are valid periodic repeats");
  assert.equal(s.tracking(packetAt(publication("available"),999999999n),3),null);
  assert.equal(s.active.get(7)?.counters.get(1),254n);
  assert.ok(s.tracking(publication("inactive_inputs"),5));
  assert.equal(s.active.get(7)?.deltas.get(1),3n);
  assert.deepEqual(s.active.get(7)?.packet?.values,[false,1,0]);
  for(const bad of [publication("available").slice(0,-1),Buffer.concat([publication("available"),Buffer.from([0])]),Uint8Array.of(0)]) assert.equal(s.tracking(bad,6),null);
  const padding=packetAt(publication("available"),1020000001n);padding[20]=0x81;
  assert.deepEqual(s.tracking(padding,7)?.values,[true,254,128/255]);
});

test("fresh ids isolate delayed old-layout datagrams; reliable same-id replacement and rejection preserve ordering", () => {
  const s=session(); s.request(request);
  assert.equal(s.tracking(publication("available"),0),null);
  s.receive({tag:5,id:7}); assert.ok(s.tracking(publication("available"),1));
  const changed={...request,id:8,samples:[request.samples[2]]};
  s.request(changed); s.receive({tag:6,id:8}); assert.equal(s.active.get(7)?.request.samples.length,3);
  s.request(changed); s.receive({tag:5,id:8}); s.stop(7); s.receive({tag:8,id:7,reason:"Unsubscribed"});
  assert.equal(s.tracking(packetAt(publication("available"),2000000000n),2),null);
  const fresh=Buffer.alloc(21);fresh.writeUInt32LE(8);fresh.writeBigUInt64LE(1n,4);fresh.writeBigUInt64LE(NON_MAX,12);
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
test("pose tolerance, nonfinite values and zero rotations; individual joints disappear when stale or ended", () => {
  for (const format of [10,11]) {
    const caps: Capabilities={ skeletons: [], groups:[60],descriptors:[{id:"/body/FB/7",name:"Head joint",description:"",group:0,kind:10,formats:[format],spaces:[2]}]};
    caps.skeletons = [{joints:[{parent:0,pose_sample:0,rest_pose_sample:0}]}];
    const r={id:1,group:0,delivery: 1, schedule:periodic(60),samples:[{descriptor:0,format,space:2}]};
    const bytes=Buffer.alloc(20+7*(format===10?4:8)); bytes.writeUInt32LE(1);bytes.writeBigUInt64LE(NON_MAX,12);
    const set=(i:number,n:number)=>format===10?bytes.writeFloatLE(n,20+i*4):bytes.writeDoubleLE(n,20+i*8);
    set(0,1);set(1,2);set(2,3);
    const tolerance=format===10?1e-5:1e-12;
    set(6,Math.sqrt(1+tolerance/2)); assert.doesNotThrow(()=>decodeTracking(bytes,caps,r));
    set(6,Math.sqrt(1+tolerance*2)); assert.throws(()=>decodeTracking(bytes,caps,r));
    set(6,0); assert.throws(()=>decodeTracking(bytes,caps,r));
    set(6,1);set(0,NaN); assert.throws(()=>decodeTracking(bytes,caps,r));set(0,1);
    const s=new Session();s.receive({tag:2,version:1});s.receive({tag:3,capabilities:caps});s.request(r);s.receive({tag:5,id:1});s.tracking(bytes,100);
    const view=spatialFrames(s,101);assert.equal(view.body.active,true);assert.equal(view.body.poses.filter(p=>p.flags===3).length,1);assert.deepEqual(view.body.poses[0].position,[1,2,3]);
    assert.equal(spatialFrames(s,1000).body.active,false);
    s.receive({tag:8,id:1,reason:"Source lost"});assert.equal(spatialFrames(s,1101).body.active,false);
  }
});

test("spatial overlay never combines different reference spaces", () => {
  const caps: Capabilities = { skeletons: [], groups:[60],descriptors:["head","controller"].map(id=>({id,name:id,description:"",group:0,kind:10,formats:[10],spaces:[1,2]}))};
  const s=new Session();s.receive({tag:2,version:1});s.receive({tag:3,capabilities:caps});
  const r={id:1,group:0,delivery: 1, schedule:periodic(60),samples:[{descriptor:0,format:10,space:1},{descriptor:1,format:10,space:2}]};
  s.request(r);s.receive({tag:5,id:1});
  const b=Buffer.alloc(76);b.writeUInt32LE(1);b.writeBigUInt64LE(NON_MAX,12);b.writeFloatLE(1,44);b.writeFloatLE(1,72);
  assert.ok(s.tracking(b,0));
  const view=spatialFrames(s,1);assert.equal(view.mixedSpaces,true);assert.equal(view.poses.poses.length,0);assert.equal(view.body.active,false);
  assert.equal(s.active.get(1)?.packet?.values.length,2,"Numerical values remain inspectable");
});

test("fixed boolean packing crosses bytes and ignores unused high bits", () => {
  const caps: Capabilities={ skeletons: [], groups:[60],descriptors:Array.from({length:9},(_,i)=>({id:String(i),name:"",description:"",kind:2,formats:[1],group:0,spaces:[]}))};
  const r={id:1,group:0,delivery:1,schedule:periodic(60),samples:caps.descriptors.map((_,descriptor)=>({descriptor,format:1,space:0}))};
  const b=Buffer.alloc(22);b.writeUInt32LE(1);b.writeBigUInt64LE(NON_MAX,12);b.set([0x55,1],20);
  const expected=[true,false,true,false,true,false,true,false,true];
  assert.deepEqual(decodeTracking(b,caps,r).values,expected);
  b[21]=0xff;assert.deepEqual(decodeTracking(b,caps,r).values,expected);
  assert.throws(()=>decodeTracking(b.slice(0,-1),caps,r));
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
    assert.ok(s.tracking(publication("available"),0,delivery));
    const sub=s.active.get(7)!,packet=sub.packet,samples=sub.request.samples;
    assert.deepEqual(s.changeSchedule(7,{kind:"onChange"}),wire("0c0700000002"));
    assert.equal(sub.packet,packet);assert.equal(sub.request.samples,samples);assert.equal(sub.request.schedule.kind,"onChange");
    const schedule=periodic(50,25_000_000n,9007199254740993n);
    assert.deepEqual(s.changeSchedule(7,schedule),updateSchedule(7,schedule));assert.equal(sub.request.schedule.kind,"periodic");
    for(const field of ["interval","phase","consumptionDelay"] as const)assert.throws(()=>validateSchedule({...periodic(50),[field]:NON_MAX} as any));
    assert.throws(()=>validateSchedule({kind:"periodic",interval:0n,phase:0n,consumptionDelay:0n}));
  }
  const b=publication("available"); new DataView(b.buffer,b.byteOffset,b.byteLength).setBigUint64(4,NON_MAX,true);
  assert.throws(()=>decodeTracking(b,c,request));
  const s=session();s.requestClock(0);const response=Buffer.alloc(21);response[0]=11;response.writeBigUInt64LE(NON_MAX,5);response.writeBigUInt64LE(NON_MAX,13);
  s.unreliable(response,1);assert.equal(s.clock,undefined);
});

test("clock offsets follow drift and stop reusing old low-delay observations", () => {
  const s = session();
  const probe = (sent: number, transit: number, offset: bigint) => {
    const request = s.requestClock(sent)!, response = Buffer.alloc(21);
    response[0] = 11; response.writeUInt32LE(new DataView(request.buffer).getUint32(1, true), 1);
    response.writeBigUInt64LE(BigInt(Math.round((sent + transit) * 1e6)) + offset, 5);
    response.writeBigUInt64LE(BigInt(Math.round((sent + transit) * 1e6)) + offset, 13);
    s.unreliable(response, sent + transit * 2);
  };
  probe(1000, 1, 1_000_000_000n);
  probe(2000, 1, 1_001_000_000n);
  assert.equal(s.clock!.offset, 1_001_000_000n, "Equal-delay probes prefer the newer clock relation");
  probe(3000, 2, 1_002_000_000n);
  assert.equal(s.clock!.offset, 1_001_000_000n, "A fresh lower-delay observation still filters queue noise");
  probe(4000, 2, 1_003_000_000n);
  assert.equal(s.clock!.offset, 1_003_000_000n, "Older minimum delay must not hold the phase on a stale offset");
});

test("consumption selects coherent predictions by time, including reordered arrivals, and clears them on tracking loss", () => {
  const s = new Session();
  const caps: Capabilities = { groups: [200], skeletons: [], descriptors: [
    {id: 'pose', name: '', description: '', kind: 10, group: 0, formats: [10], spaces: [2], position_valid_sample: 1},
    {id: 'valid', name: '', description: '', kind: 12, group: 0, formats: [1], spaces: []},
  ] };
  s.receive({tag: 2, version: 1}); s.receive({tag: 3, capabilities: caps});
  s.request({id: 7, group: 0, delivery: 1, schedule: periodic(200), samples: [{descriptor: 0, format: 10, space: 2}, {descriptor: 1, format: 1, space: 0}]});
  s.receive({tag: 5, id: 7});
  const origin = 9_007_199_254_740_993n;
  s.clock = {offset: origin, delay: 2_000_000n, at: 0};
  const packet = (acquired: number, represented: number | null, valid = true) => {
    const b = new Uint8Array(49), v = new DataView(b.buffer);
    v.setUint32(0, 7, true); v.setBigUint64(4, origin + BigInt(acquired) * 1_000_000n, true);
    v.setBigUint64(12, represented === null ? NON_MAX : origin + BigInt(represented) * 1_000_000n, true);
    b[20] = Number(valid); v.setFloat32(21, acquired, true); v.setFloat32(45, 1, true);
    return b;
  };
  const sub = s.active.get(7)!;
  s.tracking(packet(1, 10), 4);
  s.tracking(packet(3, 20, false), 5);
  s.tracking(packet(2, 15), 6);
  for (const target of [10, 15, 20]) {
    s.consume(target);
    assert.equal(selectedPacket(sub)!.predictedFor, origin + BigInt(target) * 1_000_000n);
    const values = currentValues(s, target);
    assert.equal(values.get(0)!.packet, values.get(1)!.packet, 'Pose and validity come from the same publication');
  }
  assert.equal(sub.packet!.timestamp, origin + 3_000_000n, 'Reordering does not rewind the acquisition baseline');
  s.tracking(packet(4, 30), 21);
  s.consume(22, 8);
  assert.equal(selectedPacket(sub)!.predictedFor, origin + 30_000_000n, 'Explicit consumption offset is honored');
  s.tracking(packet(5, null, false), 23);
  s.consume(24);
  assert.equal(selectedPacket(sub), sub.packet, 'Unavailable current data supersedes buffered valid predictions');
  assert.equal(currentValues(s, 24).get(1)!.value, false);
  s.tracking(packet(4, 40), 25);
  s.tracking(packet(6, 50), 26);
  s.tracking(packet(4, 40), 27);
  s.consume(40);
  assert.equal(selectedPacket(sub), sub.packet, 'Delayed predictions from before tracking loss cannot re-enter after tracking resumes');
});
