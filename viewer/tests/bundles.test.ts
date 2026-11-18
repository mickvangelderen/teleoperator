import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Session } from "../src/session";
import { acknowledge, sequencePosition, timing, NON_MAX, validateCapabilities } from "../src/protocol";
import type { Request, Capabilities } from "../src/protocol";
import { currentValues, spatialFrames } from "../src/tracking-view";
const spec = JSON.parse(readFileSync(new URL("../../protocol/testdata/specification-v1.json", import.meta.url), "utf8"));
const wire = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const caps: Capabilities = { groups: [60], skeletons: [], descriptors: Array.from({length: 3}, (_, i) => ({id: String(i), name: "", description: "", kind: 1, formats: [1], spaces: [], group: 0})) };
function setup(delivery = 1) {
  const s = new Session(); s.receive({tag: 2, version: 1}); s.receive({tag: 3, capabilities: structuredClone(caps)});
  const request: Request = {id: 1, group: 0, delivery, ...timing(60), sequenceNumberFormat: 1, bundles: caps.descriptors.map((_, descriptor) => [{descriptor, format: 1, space: 0}])};
  s.request(request); s.receive({tag: 5, id: 1}); return s;
}
// Independent, deliberately narrow fixture: three independently byte-packed boolean bundles.
function publication(sequence: bigint, included: number[], timestamp = sequence, value = true) {
  const b = Buffer.alloc(23 + included.length); b.writeUInt32LE(1); b.writeBigUInt64LE(timestamp, 4); b.writeBigUInt64LE(NON_MAX, 12);
  b.writeUInt16LE(Number(sequence), 20); b[22] = (included.includes(1) ? 1 : 0) | (included.includes(2) ? 2 : 0);
  for(let i=0; i<included.length; i++) b[23+i] = Number(value);
  return b;
}

test("static sequence and exact acknowledgment vectors cover all widths and wrap", () => {
  for(const v of spec.sequence_examples) {
    const old = BigInt(v.previous), next = sequencePosition(BigInt(v.current), old, v.format);
    const order = next === null ? "ambiguous" : next === old ? "duplicate" : next > old ? "newer" : "older";
    assert.equal(order, v.order);
  }
  for(const v of spec.datagrams.filter((v: any) => v.tag === 13)) assert.deepEqual(
    acknowledge(v.value.subscription_id, spec.requests[v.request].value.sequence_number_format, BigInt(v.value.sequence_number)), wire(v.hex));
});

test("static receive traces order each bundle against an unwrapped subscription sequence", () => {
  for (const trace of spec.receive_traces.filter((t: any) => t.name !== "optional_continuous_only_ack")) {
    const s = setup();
    for (const step of trace.steps) {
      const sub = s.active.get(1)!, previous = [...sub.bundles];
      s.tracking(publication(BigInt(step.sequence), step.bundles), 100);
      assert.deepEqual(sub.bundles.flatMap((b,i) => b !== previous[i] ? [i] : []), step.apply, trace.name);
      const acks = s.takeAcknowledgments(); assert.equal(acks.length, Number(step.ack), trace.name);
      if (acks.length) assert.deepEqual(acks[0], acknowledge(1,1,BigInt(step.sequence)));
    }
  }
});

test("sparse publications retain original values, times and freshness; duplicate/older packets still ACK", () => {
  const s = setup(); s.tracking(publication(0n,[0,1,2],100n),100); s.takeAcknowledgments();
  const original = s.active.get(1)!.bundles[1];
  s.tracking(publication(2n,[0,2],200n,false),400);
  assert.equal(s.active.get(1)!.bundles[1], original);
  assert.equal(currentValues(s,401).get(1)!.packet!.timestamp,100n);
  assert.equal(currentValues(s,601).get(1)!.stale,false, "Retained state stays current through ongoing publications");
  assert.equal(currentValues(s,901).get(1)!.stale,true, "A continuous stream falling silent loses liveness");
  assert.equal(currentValues(s,601).get(2)!.stale,false);
  s.takeAcknowledgments();
  assert.ok(s.tracking(publication(1n,[0,1],150n,false),450));
  assert.equal(s.active.get(1)!.bundles[0]!.packet.timestamp,200n);
  assert.equal(s.active.get(1)!.bundles[1]!.packet.timestamp,150n);
  s.takeAcknowledgments();
  assert.equal(s.tracking(publication(1n,[0,1],150n,false),460),null);
  assert.deepEqual(s.takeAcknowledgments(),[acknowledge(1,1,1n)]);
  s.tracking(publication(0n,[0,1,2],100n),470);
  assert.deepEqual(s.takeAcknowledgments(),[acknowledge(1,1,0n)]);
});

test("pending replacements discard unreliable layouts and queued ACKs, keep reliable order, and accept without ending", () => {
  for(const delivery of [1,2]) for(const outcome of ["accept", "reject", "endAccept", "endReject"]){
    const s=setup(delivery), old=s.active.get(1)!;
    s.tracking(publication(4n,[0,1,2]),100,delivery);
    const replacement={...old.request, predictionOffset: 2n};
    s.request(replacement); assert.deepEqual(s.takeAcknowledgments(),[]);
    const packet=s.tracking(publication(5n,[0,1,2]),110,delivery);
    assert.equal(packet!==null,delivery===2); assert.deepEqual(s.takeAcknowledgments(),[]);
    if(outcome.startsWith("end")){s.receive({tag:8,id:1,reason:"Source ended"});assert.ok(s.pending.has(1));}
    if(outcome.endsWith("Reject")||outcome==="reject"){
      s.receive({tag:6,id:1,reason:"No"});
      if(outcome==="reject"){
        assert.equal(s.active.get(1),old); s.tracking(publication(6n,[0,1,2]),120,delivery);
        assert.deepEqual(s.takeAcknowledgments(),[acknowledge(1,1,6n)]);
      }else assert.equal(s.active.size,0);
    }else{
      s.receive({tag:5,id:1}); assert.notEqual(s.active.get(1),old); assert.equal(s.active.get(1)!.bundles[0],undefined);
      s.tracking(publication(0n,[0,1,2]),120,delivery); assert.deepEqual(s.takeAcknowledgments(),[acknowledge(1,1,0n)]);
    }
  }
});

test("malformed publications are atomic discards on either channel, including before discovery", () => {
  assert.equal(new Session().control(Uint8Array.of(9),0),null);
  for(const delivery of [1,2]){
    const s=setup(delivery), good=publication(0n,[0,1,2]);s.tracking(good,0,delivery);s.takeAcknowledgments();
    const original=[...s.active.get(1)!.bundles];
    for(const bad of [good.subarray(0,good.length-1),Buffer.concat([good,Buffer.from([0])]),publication(32768n,[0,1,2])]){
      assert.equal(s.tracking(bad,1,delivery),null); assert.deepEqual(s.takeAcknowledgments(),[]);
      assert.deepEqual(s.active.get(1)!.bundles,original);
    }
  }
  for(const v of spec.message_outcomes.filter((v:any)=>v.hex.startsWith("03"))) assert.throws(()=>{
    const s=new Session();s.receive({tag:2,version:1});s.control(wire(v.hex),0);
  },v.name);
});

test("discovery rejects cycles and unresolved parent spaces but permits unambiguous sharing", () => {
  const c: Capabilities={groups:[60],descriptors:[{id:"pose",name:"",description:"",group:0,kind:10,formats:[10],spaces:[5]}],skeletons:[]};
  assert.throws(()=>validateCapabilities(c),/parent frame/);
  c.skeletons=[{joints:[{parent:0,pose_sample:0,rest_pose_sample:0}]}];validateCapabilities(c);
  c.skeletons[0].joints.push({parent:0,pose_sample:0,rest_pose_sample:0});validateCapabilities(c);
  c.skeletons[0].joints[0].parent=1;assert.throws(()=>validateCapabilities(c),/cycle/);
});

test("capability validation adds no unadvertised uniqueness or nonempty-id restrictions", () => {
  const c: Capabilities = { groups:[60], skeletons:[], descriptors:[{id:"",name:"",description:"",group:0,kind:10,formats:[10,10],spaces:[2,2]}] };
  assert.doesNotThrow(()=>validateCapabilities(c));
  c.descriptors.push({...c.descriptors[0]}); assert.throws(()=>validateCapabilities(c),/Duplicate sample id/);
});

test("on-change pose silence retains geometry and original acquisition metadata until retirement", () => {
  const s=new Session(), capabilities: Capabilities={groups:[60],skeletons:[],descriptors:[{id:"pose",name:"",description:"",kind:10,formats:[10],spaces:[2],group:0}]};
  s.receive({tag:2,version:1});s.receive({tag:3,capabilities});
  s.request({id:1,group:0,delivery:1,...timing(60),sequenceNumberFormat:1,bundles:[[],[{descriptor:0,format:10,space:2}]]});s.receive({tag:5,id:1});
  const packet=Buffer.alloc(51);packet.writeUInt32LE(1);packet.writeBigUInt64LE(100n,4);packet.writeBigUInt64LE(NON_MAX,12);packet[22]=1;packet.writeFloatLE(1,23);packet.writeFloatLE(1,47);
  s.tracking(packet,100);assert.equal(s.takeAcknowledgments().length,1);
  const original=s.active.get(1)!.bundles[1];
  const value=currentValues(s,60_000).get(0)!;
  assert.equal(value.stale,false);assert.equal(value.packet!.timestamp,100n);
  assert.equal(s.active.get(1)!.bundles[1],original);
  assert.equal(spatialFrames(s,60_000).poses.poses.length,1);
  assert.equal(s.freshness(60_000).status,"Inactive","Intentional silence does not establish live acquisition freshness");
  s.receive({tag:8,id:1,reason:"Ended"});assert.equal(currentValues(s,60_001).size,0);assert.equal(spatialFrames(s,60_001).poses.poses.length,0);
});

test("delayed and duplicate publications do not disguise a mixed stream's liveness loss",()=>{
  const s=setup();s.tracking(publication(0n,[0,1,2],100n),100);s.tracking(publication(2n,[0],200n),400);
  s.tracking(publication(1n,[0,1],150n),899);s.tracking(publication(2n,[0],200n),900);
  assert.equal(s.active.get(1)!.acquiredAtArrival,400);
  assert.equal(currentValues(s,901).get(1)!.stale,true);
  s.tracking(publication(3n,[0],300n),1000);
  assert.equal(currentValues(s,1001).get(1)!.stale,false);
  assert.equal(currentValues(s,1001).get(1)!.packet!.timestamp,150n);
  s.retire();assert.equal(currentValues(s,1002).size,0);
});

test("fresh sequences repeating a frozen acquisition cannot keep omitted mixed bundles current",()=>{
  const s=setup();s.tracking(publication(0n,[0,1,2],100n),100);s.takeAcknowledgments();
  const retained=s.active.get(1)!.bundles[1];
  for(let sequence=1;sequence<=60;sequence++) s.tracking(publication(BigInt(sequence),[0],100n),100+sequence*1000/60);
  const frozen=currentValues(s,1100);
  assert.equal(frozen.get(0)!.stale,true);
  assert.equal(frozen.get(1)!.stale,true,"Omission cannot imply fresh source state when acquisition is frozen");
  assert.equal(s.active.get(1)!.acquiredAtArrival,100);
  assert.equal(s.active.get(1)!.bundles[1],retained);
  assert.deepEqual(s.takeAcknowledgments(),[]);
  s.tracking(publication(61n,[0],200n),1110);
  assert.equal(currentValues(s,1111).get(1)!.stale,false,"A newer source acquisition restores mixed-state currency");
  assert.equal(currentValues(s,1111).get(1)!.packet!.timestamp,100n);
  assert.equal(s.active.get(1)!.bundles[1],retained);
});

test("all nine committed publication-discard outcomes preserve state and never ACK",()=>{
  const outcomes=spec.message_outcomes.filter((v:any)=>v.hex.startsWith("09")&&v.outcome==="discard_message");
  assert.equal(outcomes.length,9);
  for(const entry of outcomes){
    const setup=spec.requests[entry.request], r=setup.value, c=spec.capabilities[setup.capabilities];
    const s=new Session();s.receive({tag:2,version:1});s.receive({tag:3,capabilities:{groups:c.sample_groups.map((g:any)=>g.max_sample_rate_hz),descriptors:c.sample_descriptors.map((d:any)=>({...d,formats:d.supported_formats,spaces:d.supported_spaces??[]})),skeletons:c.skeletons}});
    s.request({id:r.subscription_id,group:r.group,delivery:r.channel,interval:BigInt(r.interval),phase:BigInt(r.phase),predictionOffset:BigInt(r.prediction_offset),sequenceNumberFormat:r.sequence_number_format,bundles:r.bundles.map((b:any[])=>b.map(v=>({descriptor:v.descriptor,format:v.format,space:v.reference_space??0})))});s.receive({tag:5,id:r.subscription_id});
    const good=spec.publications.find((p:any)=>p.requests.includes(entry.request));
    if(r.channel===1)s.unreliable(wire(good.hex),10);else s.control(wire(good.hex),10);
    s.takeAcknowledgments();
    const original=structuredClone(s.active.get(r.subscription_id));
    const received=entry.channel===1?s.unreliable(wire(entry.hex),20):s.control(wire(entry.hex),20);
    assert.equal(received,null,entry.name);assert.deepEqual(s.takeAcknowledgments(),[],entry.name);
    assert.deepEqual(structuredClone(s.active.get(r.subscription_id)),original,entry.name);
    assert.equal(s.phase,"ready",entry.name);assert.equal(s.discarded,1,entry.name);
  }
});
