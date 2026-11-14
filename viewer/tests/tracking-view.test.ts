import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/session";
import { spatialFrames, stale } from "../src/tracking-view";
import type { Capabilities, Value } from "../src/protocol";

function publish(s: Session, id: number, timestamp: bigint, values: (Value | null)[], arrivedAt = 100) {
  const sub = s.active.get(id)!, header = Buffer.alloc(17), payload: Buffer[] = [];
  header.writeUInt32LE(id); header.writeUInt32LE(sub.generation,4); header.writeBigUInt64LE(timestamp,8);
  let booleans = 0, count = 0;
  values.forEach((value,i) => {
    if (value === null) return;
    header[16] |= 1 << i;
    const format = sub.request.samples[i].format;
    if (format === 1) { if (value) booleans |= 1 << count; count++; return; }
    const bytes = Buffer.alloc(format === 2 ? 1 : format === 4 ? 4 : 28);
    if (format === 2) bytes.writeUInt8(Number(value));
    else if (format === 4) bytes.writeUInt32LE(Number(value));
    else (value as number[]).forEach((v,j) => bytes.writeFloatLE(v,j*4));
    payload.push(bytes);
  });
  assert.ok(s.tracking(Buffer.concat([header, ...(count ? [Buffer.from([booleans])] : []), ...payload]), arrivedAt, sub.request.delivery));
}
function setup() {
  const c: Capabilities = { groups: [60,60], descriptors: [
    {id:"root",kind:10,formats:[10],spaces:[2],group:0,position_valid_sample:4,orientation_valid_sample:5},
    {id:"child",kind:10,formats:[10],spaces:[5],group:0},
    {id:"rest-root",kind:10,formats:[10],spaces:[5],group:1},
    {id:"rest-child",kind:10,formats:[10],spaces:[5],group:1},
    {id:"position",kind:12,formats:[1],spaces:[],group:0},
    {id:"rotation",kind:13,formats:[1],spaces:[],group:0},
    {id:"revision",kind:11,formats:[2],spaces:[],group:0,revision_of:1},
    {id:"rest-revision",kind:11,formats:[4],spaces:[],group:1,revision_of:1},
  ].map(d=>({name:d.id,description:"",...d})), skeletons:[{joints:[{parent:0,pose_sample:0,rest_pose_sample:2},{parent:0,pose_sample:1,rest_pose_sample:3}]}] };
  const s = new Session(); s.receive({tag:2,version:1}); s.receive({tag:3,capabilities:c});
  for (let group=0;group<2;group++) {
    s.request({id:group,group,delivery:group+1,rate:60,samples:c.descriptors.flatMap((d,descriptor)=>d.group===group?[{descriptor,format:d.formats[0],space:d.spaces[0]??0}]:[])});
    s.receive({tag:5,id:group,generation:group+1});
  }
  publish(s,1,1n,[[0,0,0,0,0,0,1],[2,0,0,0,0,0,1],257]);
  publish(s,0,2n,[[1,2,3,0,0,Math.SQRT1_2,Math.SQRT1_2],[1,0,0,0,0,0,1],true,true,1]);
  return s;
}
test("tracking loss is distinct from missing tracking samples and never changes validity", () => {
  const s = new Session();
  const capabilities: Capabilities = { groups: [60], skeletons: [{ joints: [{ parent: 0, pose_sample: 0, rest_pose_sample: 0 }] }], descriptors: [
    { id: "pose", kind: 10, formats: [10], spaces: [2], position_valid_sample: 1, orientation_valid_sample: 2, position_tracked_sample: 3, orientation_tracked_sample: 4 },
    { id: "position-valid", kind: 12, formats: [1], spaces: [] },
    { id: "orientation-valid", kind: 13, formats: [1], spaces: [] },
    { id: "position-tracked", kind: 14, formats: [1], spaces: [] },
    { id: "orientation-tracked", kind: 15, formats: [1], spaces: [] },
  ].map(d => ({ ...d, name: d.id, description: "", group: 0 })) };
  s.receive({ tag: 2, version: 1 }); s.receive({ tag: 3, capabilities });
  s.request({ id: 1, group: 0, delivery: 1, rate: 60, samples: capabilities.descriptors.map((d, descriptor) => ({ descriptor, format: d.formats[0], space: d.spaces[0] ?? 0 })) });
  s.receive({ tag: 5, id: 1, generation: 1 });
  const pose = [0, 1, 0, 0, 0, 0, 1];
  let timestamp = 1n;
  for (const [position, orientation, expected] of [[true, true, true], [false, true, false], [true, false, false], [false, false, false], [true, null, undefined], [null, false, false], [null, null, undefined]] as const) {
    publish(s, 1, timestamp++, [pose, true, true, position, orientation]);
    const joint = spatialFrames(s, 101).body.poses[0];
    assert.equal(joint.tracked, expected);
    assert.equal(joint.flags & 3, 3);
  }
  publish(s, 1, timestamp++, [pose, false, true, true, true]);
  assert.equal(spatialFrames(s, 101).body.active, false, "Tracked flags cannot make an invalid position visible");
  publish(s, 1, timestamp++, [pose, true, false, true, true]);
  assert.equal(spatialFrames(s, 101).body.poses[0].flags & 3, 2, "Orientation validity stays independent");
  s.active.get(1)!.request.samples.length = 3;
  publish(s, 1, timestamp++, [pose, true, true]);
  assert.equal(spatialFrames(s, 101).body.poses[0].tracked, undefined, "Unsubscribed flags are unknown");
  assert.ok(spatialFrames(setup(), 101, true).body.poses.every(p => p.tracked === undefined), "Rest poses do not report tracking loss");
});
test("advertised hierarchy composes parent poses and honors component validity", () => {
  const s = setup(), view = spatialFrames(s,101);
  assert.equal(view.body.poses.length,2); assert.equal(view.body.active,true);
  assert.deepEqual(view.hierarchy.joints,[{id:0,parent:-1},{id:1,parent:0}]);
  const p = view.body.poses[1].position; [1,3,3].forEach((n,i)=>assert.ok(Math.abs(n-p[i])<1e-6));
  s.active.get(0)!.packet!.values[2]=false;
  const invalid = spatialFrames(s,101); assert.equal(invalid.body.poses[0].flags & 2,0); assert.equal(invalid.body.poses[1].flags,0);
  assert.equal(spatialFrames(s,1000).body.active,false);
});
test("rest poses are reconstructed only when group revisions agree modulo counter width", () => {
  const s = setup(), rest = spatialFrames(s,101,true); assert.equal(rest.body.active,true);
  assert.deepEqual(rest.body.poses[1].position,[2,0,0]); assert.equal(rest.space,-1);
  s.active.get(1)!.packet!.values[2]=258;
  assert.equal(spatialFrames(s,101,true).body.active,false);
  assert.equal(spatialFrames(s,101).body.active,true);
});
test("cycles and unanchored live roots are not rendered as world poses", () => {
  const s = setup(), c = structuredClone(s.capabilities!); c.skeletons[0].joints[0].parent=1;
  c.descriptors[0].spaces=[5]; s.capabilities=c; s.active.get(0)!.request.samples[0].space=5;
  assert.equal(spatialFrames(s,101).body.active,false);
});
test("reliable rest snapshots persist, become unavailable explicitly, and reset with their subscription", () => {
  const s = setup(), rest = s.active.get(1)!;
  assert.equal(rest.onChange,true); assert.equal(s.active.get(0)!.onChange,false);
  assert.equal(stale(rest,60_000),false); assert.equal(spatialFrames(s,60_000,true).body.active,true);
  publish(s,1,3n,[null,null,null],60_001);
  assert.equal(spatialFrames(s,60_002,true).body.active,false);
  publish(s,1,4n,[[0,0,0,0,0,0,1],[2,0,0,0,0,0,1],257],60_003);
  assert.equal(spatialFrames(s,120_000,true).body.active,true);
  s.request(rest.request); s.receive({tag:8,id:1,generation:2,reason:"replaced"}); s.receive({tag:5,id:1,generation:3});
  assert.equal(spatialFrames(s,120_001,true).body.active,false);
  publish(s,1,5n,rest.packet!.values,120_002);
  assert.equal(spatialFrames(s,120_003,true).body.active,true);
  s.stop(1); assert.equal(spatialFrames(s,120_004,true).body.active,false);
  s.retire(); assert.equal(s.revisions.size,0);
});
test("a known revision change keeps old rest hidden after live tracking expires or stops", () => {
  const s = setup(), rest = s.active.get(1)!.packet!.values;
  publish(s,0,3n,[...s.active.get(0)!.packet!.values.slice(0,-1),2],200);
  assert.equal(spatialFrames(s,201,true).body.active,false);
  assert.equal(spatialFrames(s,60_000,true).body.active,false);
  s.stop(0); assert.equal(spatialFrames(s,60_001,true).body.active,false);
  publish(s,1,4n,[...rest.slice(0,-1),258],60_002);
  assert.equal(spatialFrames(s,120_000,true).body.active,true);
});
test("a newer reliable snapshot wins over delayed live revision observations", () => {
  const s = setup();
  publish(s,1,10n,[...s.active.get(1)!.packet!.values.slice(0,-1),258],200);
  publish(s,0,9n,s.active.get(0)!.packet!.values,201);
  assert.equal(spatialFrames(s,202,true).body.active,true);
});
test("revision changes invalidate snapshots even when their self-revision was deselected", () => {
  const s = setup(), rest = s.active.get(1)!;
  rest.request.samples.pop(); rest.packet!.values.pop();
  assert.equal(spatialFrames(s,101,true).body.active,true);
  publish(s,0,3n,[...s.active.get(0)!.packet!.values.slice(0,-1),2],200);
  assert.equal(spatialFrames(s,201,true).body.active,false);
  publish(s,1,4n,rest.packet!.values,202);
  assert.equal(spatialFrames(s,60_000,true).body.active,true);
});
test("unreliable rest keeps the periodic freshness deadline", () => {
  const s = setup(), rest = s.active.get(1)!;
  s.request({...rest.request,delivery:1}); s.receive({tag:8,id:1,generation:2,reason:"replaced"}); s.receive({tag:5,id:1,generation:3});
  assert.equal(s.active.get(1)!.onChange,false);
  publish(s,1,3n,rest.packet!.values);
  assert.equal(spatialFrames(s,101,true).body.active,true);
  assert.equal(spatialFrames(s,1000,true).body.active,false);
});
