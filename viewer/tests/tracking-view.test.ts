import { timing, NON_MAX } from "../src/protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/session";
import { spatialFrames, staleBundle } from "../src/tracking-view";
import type { Capabilities, Value } from "../src/protocol";

function publish(s: Session, id: number, timestamp: bigint, values: Value[], arrivedAt = 100) {
  const sub = s.active.get(id)!, bundle = sub.request.bundles.findIndex(b => b.length > 0), header = Buffer.alloc(sub.request.sequenceNumberFormat === null ? 20 : 25), payload: Buffer[] = [];
  if (sub.request.sequenceNumberFormat !== null) { header.writeUInt32LE(sub.packets,20); header[24]=1; }
  header.writeUInt32LE(id); header.writeBigUInt64LE(timestamp,4); header.writeBigUInt64LE(NON_MAX,12);
  let booleans = 0, count = 0;
  values.forEach((value,i) => {
    const format = sub.request.bundles[bundle][i].format;
    if (format === 1) { if (value) booleans |= 1 << count; count++; return; }
    const bytes = Buffer.alloc(format === 2 ? 1 : format === 4 ? 4 : Array.isArray(value) ? value.length * 4 : 4);
    if (format === 2) bytes.writeUInt8(Number(value));
    else if (format === 4) bytes.writeUInt32LE(Number(value));
    else (Array.isArray(value) ? value : [Number(value)]).forEach((v,j) => bytes.writeFloatLE(v,j*4));
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
    s.request({id:group,group,delivery:group+1,...timing(60),sequenceNumberFormat: null, bundles: [c.descriptors.flatMap((d,descriptor)=>d.group===group?[{descriptor,format:d.formats[0],space:d.spaces[0]??0}]:[])]});
    if (group === 1) { const r=s.pending.get(group)!; r.bundles=[[],...r.bundles]; r.sequenceNumberFormat=2; }
    s.receive({tag:5,id:group});
  }
  publish(s,1,1n,[[0,0,0,0,0,0,1],[2,0,0,0,0,0,1],257]);
  publish(s,0,2n,[[1,2,3,0,0,Math.SQRT1_2,Math.SQRT1_2],[1,0,0,0,0,0,1],true,true,1]);
  return s;
}
test("tracking loss is distinct from unselected tracking samples and never changes validity", () => {
  const s = new Session();
  const capabilities: Capabilities = { groups: [60], skeletons: [{ joints: [{ parent: 0, pose_sample: 0, rest_pose_sample: 0 }] }], descriptors: [
    { id: "pose", kind: 10, formats: [10], spaces: [2], position_valid_sample: 1, orientation_valid_sample: 2, position_tracked_sample: 3, orientation_tracked_sample: 4 },
    { id: "position-valid", kind: 12, formats: [1], spaces: [] },
    { id: "orientation-valid", kind: 13, formats: [1], spaces: [] },
    { id: "position-tracked", kind: 14, formats: [1], spaces: [] },
    { id: "orientation-tracked", kind: 15, formats: [1], spaces: [] },
  ].map(d => ({ ...d, name: d.id, description: "", group: 0 })) };
  s.receive({ tag: 2, version: 1 }); s.receive({ tag: 3, capabilities });
  s.request({ id: 1, group: 0, delivery: 1, ...timing(60), sequenceNumberFormat: null, bundles: [capabilities.descriptors.map((d, descriptor) => ({ descriptor, format: d.formats[0], space: d.spaces[0] ?? 0 }))]});
  s.receive({ tag: 5, id: 1 });
  const pose = [0, 1, 0, 0, 0, 0, 1];
  let timestamp = 1n;
  for (const [position, orientation, expected] of [[true, true, true], [false, true, false], [true, false, false], [false, false, false]] as const) {
    publish(s, 1, timestamp++, [pose, true, true, position, orientation]);
    const joint = spatialFrames(s, 101).body.poses[0];
    assert.equal(joint.tracked, expected);
    assert.equal(joint.flags & 3, 3);
  }
  publish(s, 1, timestamp++, [pose, false, true, true, true]);
  assert.equal(spatialFrames(s, 101).body.active, false, "Tracked flags cannot make an invalid position visible");
  publish(s, 1, timestamp++, [pose, true, false, true, true]);
  assert.equal(spatialFrames(s, 101).body.poses[0].flags & 3, 2, "Orientation validity stays independent");
  s.active.get(1)!.request.bundles[0].length = 3;
  publish(s, 1, timestamp++, [pose, true, true]);
  assert.equal(spatialFrames(s, 101).body.poses[0].tracked, undefined, "Unsubscribed flags are unknown");
  assert.ok(spatialFrames(setup(), 101, true).body.poses.every(p => p.tracked === undefined), "Rest poses do not report tracking loss");
});
test("advertised hierarchy composes parent poses and honors component validity", () => {
  const s = setup(), view = spatialFrames(s,101);
  assert.equal(view.body.poses.length,2); assert.equal(view.body.active,true);
  assert.deepEqual(view.hierarchy.joints,[{id:0,parent:-1},{id:1,parent:0}]);
  const p = view.body.poses[1].position; [1,3,3].forEach((n,i)=>assert.ok(Math.abs(n-p[i])<1e-6));
  s.active.get(0)!.packet!.bundles[0]![2]=false;
  const invalid = spatialFrames(s,101); assert.equal(invalid.body.poses[0].flags & 2,0); assert.equal(invalid.body.poses[1].flags,0);
  assert.equal(spatialFrames(s,1000).body.active,false);
});
test("rest poses are reconstructed only when group revisions agree modulo counter width", () => {
  const s = setup(), rest = spatialFrames(s,101,true); assert.equal(rest.body.active,true);
  assert.deepEqual(rest.body.poses[1].position,[2,0,0]); assert.equal(rest.space,-1);
  s.active.get(1)!.packet!.bundles[1]![2]=258;
  assert.equal(spatialFrames(s,101,true).body.active,false);
  assert.equal(spatialFrames(s,101).body.active,true);
});
test("cycles and unanchored live roots are not rendered as world poses", () => {
  const s = setup(), c = structuredClone(s.capabilities!); c.skeletons[0].joints[0].parent=1;
  c.descriptors[0].spaces=[5]; s.capabilities=c; s.active.get(0)!.request.bundles[0][0].space=5;
  assert.equal(spatialFrames(s,101).body.active,false);
});
test("reliable rest snapshots persist and reset with replacement or termination", () => {
  const s = setup(), rest = s.active.get(1)!;
  assert.equal(rest.request.delivery,2); assert.equal(s.active.get(0)!.request.delivery,1);
  assert.equal(staleBundle(rest,1,60_000),false); assert.equal(spatialFrames(s,60_000,true).body.active,true);
  publish(s,1,4n,[[0,0,0,0,0,0,1],[2,0,0,0,0,0,1],257],60_003);
  assert.equal(spatialFrames(s,120_000,true).body.active,true);
  s.request(rest.request); s.receive({tag:8,id:1,reason:"replaced"}); s.receive({tag:5,id:1});
  assert.equal(spatialFrames(s,120_001,true).body.active,false);
  publish(s,1,5n,rest.packet!.bundles[1]!,120_002);
  assert.equal(spatialFrames(s,120_003,true).body.active,true);
  s.stop(1); assert.equal(spatialFrames(s,120_004,true).body.active,false);
  s.retire(); assert.equal(s.revisions.size,0);
});
test("a known revision change keeps old rest hidden after live tracking expires or stops", () => {
  const s = setup(), rest = s.active.get(1)!.packet!.bundles[1]!;
  publish(s,0,3n,[...s.active.get(0)!.packet!.bundles[0]!.slice(0,-1),2],200);
  assert.equal(spatialFrames(s,201,true).body.active,false);
  assert.equal(spatialFrames(s,60_000,true).body.active,false);
  s.stop(0); assert.equal(spatialFrames(s,60_001,true).body.active,false);
  publish(s,1,4n,[...rest.slice(0,-1),258],60_002);
  assert.equal(spatialFrames(s,120_000,true).body.active,true);
});
test("a newer reliable snapshot wins over delayed live revision observations", () => {
  const s = setup();
  publish(s,1,10n,[...s.active.get(1)!.packet!.bundles[1]!.slice(0,-1),258],200);
  publish(s,0,9n,s.active.get(0)!.packet!.bundles[0]!,201);
  assert.equal(spatialFrames(s,202,true).body.active,true);
});
test("Changed-value snapshots remain valid across unselected revision changes", () => {
  const s = setup(), rest = s.active.get(1)!;
  rest.request.bundles[1].pop(); rest.packet!.bundles[1]!.pop();
  assert.equal(spatialFrames(s,101,true).body.active,true);
  publish(s,0,3n,[...s.active.get(0)!.packet!.bundles[0]!.slice(0,-1),2],200);
  assert.equal(spatialFrames(s,201,true).body.active,true, "No selected value changed, so no new snapshot is owed");
  publish(s,1,4n,rest.packet!.bundles[1]!,202);
  assert.equal(spatialFrames(s,60_000,true).body.active,true);
});
test("rest definitions persist independently of transport choice", () => {
  const s = setup(), rest = s.active.get(1)!;
  s.request({...rest.request,delivery:1,...timing(60)}); s.receive({tag:8,id:1,reason:"replaced"}); s.receive({tag:5,id:1});
  assert.equal(s.active.get(1)!.request.interval,timing(60).interval);
  publish(s,1,3n,rest.packet!.bundles[1]!);
  assert.equal(spatialFrames(s,101,true).body.active,true);
  assert.equal(spatialFrames(s,1000,true).body.active,true);
});


test("repeated scheduled acquisitions count packets without keeping frozen poses fresh", () => {
  const s=setup(), sub=s.active.get(0)!, values=sub.packet!.bundles[0]!, timestamp=sub.packet!.timestamp;
  const packets=sub.packets;
  for (let now=200;now<=1000;now+=100) publish(s,0,timestamp,values,now);
  assert.equal(sub.packets,packets+9);assert.equal(sub.arrivedAt,1000);
  assert.equal(staleBundle(sub,0,1001),true);assert.equal(spatialFrames(s,1001).body.active,false);
  assert.equal(spatialFrames(s,1001,true).body.active,true,"Changed-value rest remains available");
  publish(s,0,timestamp+1n,values,1002);assert.equal(staleBundle(sub,0,1003),false);
});


test("confidence summaries honor arbitrary-id validity companions without confusing unknown and measured zero", () => {
  const confidence = "arbitrary/device/quality";
  const make = (companion: boolean, selected: boolean, statusGroup = 0) => {
    const c: Capabilities = {groups:[60,60],skeletons:[{joints:[{parent:0,pose_sample:0,rest_pose_sample:0}]}],descriptors:[
      {id:"joint",kind:10,formats:[10],spaces:[2],confidence_sample:1},
      {id:confidence,kind:16,formats:[10],spaces:[]},
      ...(companion ? [{id:`${confidence}/valid`,kind:1,formats:[1],spaces:[]}] : []),
    ].map((d,i)=>({...d,name:d.id,description:"",group:i===2?statusGroup:0}))};
    const s=new Session();s.receive({tag:2,version:1});s.receive({tag:3,capabilities:c});
    s.request({id:1,group:0,delivery:1,...timing(60),sequenceNumberFormat: null, bundles: [c.descriptors.flatMap((d,descriptor)=>descriptor===2&&!selected?[]:[{descriptor,format:d.formats[0],space:d.spaces[0]??0}])]});
    s.receive({tag:5,id:1});return s;
  };
  const pose=[0,1,0,0,0,0,1], s=make(true,true);
  publish(s,1,1n,[pose,0,false]);assert.equal(spatialFrames(s,101).confidence,undefined);
  publish(s,1,2n,[pose,0,true]);assert.equal(spatialFrames(s,101).confidence,0);
  const missing=make(true,false);publish(missing,1,1n,[pose,0]);assert.equal(spatialFrames(missing,101).confidence,undefined);
  const wrongGroup=make(true,false,1);publish(wrongGroup,1,1n,[pose,0]);
  wrongGroup.request({id:2,group:1,delivery:1,...timing(60),sequenceNumberFormat: null, bundles: [[{descriptor:2,format:1,space:0}]]});wrongGroup.receive({tag:5,id:2});
  publish(wrongGroup,2,1n,[true]);assert.equal(spatialFrames(wrongGroup,101).confidence,undefined,"Matching timestamps in different groups do not prove validity");
  const ordinary=make(false,false);publish(ordinary,1,1n,[pose,0]);assert.equal(spatialFrames(ordinary,101).confidence,0);
  // A stale separately selected companion cannot validate a fresh numerical confidence.
  const r=s.active.get(1)!.request;s.request({...r,id:2,sequenceNumberFormat: null, bundles: [[r.bundles[0][2]]]});s.receive({tag:5,id:2});
  publish(s,2,3n,[true],100);s.active.get(1)!.request.bundles[0].pop();
  publish(s,1,4n,[pose,0],1000);assert.equal(spatialFrames(s,1001).confidence,undefined);
  publish(s,2,3n,[true],1002);assert.equal(spatialFrames(s,1003).confidence,undefined,"Fresh older status cannot validate a newer confidence");
  publish(s,2,5n,[true],1004);assert.equal(spatialFrames(s,1005).confidence,undefined,"Newer status cannot validate an older confidence");
  publish(s,1,5n,[pose,0],1006);assert.equal(spatialFrames(s,1007).confidence,0,"Separate subscriptions may join the same acquisition");
});

function metaSetup() {
  const s = setup(), c = structuredClone(s.capabilities!);
  c.descriptors[0].id = "/body/FB/7";
  c.descriptors[1].id = "/body/FB/6";
  // Advertised indices deliberately differ from asset IDs and descriptor indices.
  c.skeletons[0].joints = [
    { parent: 1, pose_sample: 1, rest_pose_sample: 3 },
    { parent: 1, pose_sample: 0, rest_pose_sample: 2 },
  ];
  s.capabilities = c;
  return s;
}
test("body mesh maps advertised Meta identities and resolves independent rest/live frames", () => {
  const s = metaSetup(), live = spatialFrames(s, 101), mesh = live.bodyMesh!;
  assert.deepEqual(mesh.skeleton.joints.map(j => [j.id, j.parent]), [[6, 7], [7, -1]]);
  assert.deepEqual(mesh.skeleton.joints[0].rest.position, [2, 0, 0]);
  [1, 3, 3].forEach((n, i) => assert.ok(Math.abs(mesh.sample.poses[0].position[i] - n) < 1e-6));
  const rest = spatialFrames(s, 101, true).bodyMesh!;
  assert.deepEqual(rest.sample.poses, rest.skeleton.joints.map(j => j.rest));
  assert.equal(spatialFrames(s, 1000).bodyMesh, undefined, "Stale live acquisitions cannot retain skin");
  assert.ok(spatialFrames(s, 1000, true).bodyMesh, "Reliable rest definitions remain available");
  assert.equal(spatialFrames(setup(), 101).bodyMesh, undefined, "An arbitrary skeleton is not a Meta body");
});
test("body mesh requires current rest calibration and rejects mixed or ambiguous frames", () => {
  const s = metaSetup();
  publish(s, 0, 3n, [...s.active.get(0)!.packet!.bundles[0]!.slice(0, -1), 2], 200);
  assert.equal(spatialFrames(s, 201).bodyMesh, undefined, "Revision mismatch hides the live mesh as well as the rest view");
  assert.equal(spatialFrames(s, 201).body.active, true, "Current live joint overlay remains usable");
  publish(s, 1, 4n, [...s.active.get(1)!.packet!.bundles[1]!.slice(0, -1), 258], 202);
  assert.ok(spatialFrames(s, 203).bodyMesh);
  s.stop(1); assert.equal(spatialFrames(s, 204).bodyMesh, undefined);
  s.retire(); assert.equal(spatialFrames(s, 205).bodyMesh, undefined);

  const mixed = metaSetup();
  mixed.capabilities!.descriptors[1].spaces = [3];
  mixed.active.get(0)!.request.bundles[0][1].space = 3;
  assert.equal(spatialFrames(mixed, 101).mixedSpaces, true);
  assert.equal(spatialFrames(mixed, 101).bodyMesh, undefined);
  const mixedRest = metaSetup();
  mixedRest.capabilities!.descriptors[3].spaces = [6];
  mixedRest.active.get(1)!.request.bundles[1][1].space = 6;
  assert.equal(spatialFrames(mixedRest, 101).bodyMesh, undefined);
  const duplicate = metaSetup();
  duplicate.capabilities!.skeletons.push(structuredClone(duplicate.capabilities!.skeletons[0]));
  assert.equal(spatialFrames(duplicate, 101).bodyMesh, undefined, "Never merge separate skeletons onto one skin");
});

test("live skin requires positive revision agreement in both directions and after counter wrap", () => {
  const s = metaSetup(), live = s.active.get(0)!.packet!.bundles[0]!.slice(0, -1);
  const rest = s.active.get(1)!.packet!.bundles[1]!.slice(0, -1);
  publish(s, 1, 3n, [...rest, 258], 200);
  assert.equal(spatialFrames(s, 201).bodyMesh, undefined, "New rest cannot calibrate still-fresh older live poses");
  assert.equal(spatialFrames(s, 201).body.active, true);
  assert.ok(spatialFrames(s, 201, true).bodyMesh, "New self-consistent rest remains independently visible");
  publish(s, 0, 4n, [...live, 2], 202);
  assert.ok(spatialFrames(s, 203).bodyMesh, "Matching new live acquisition restores skin");
  publish(s, 0, 5n, [...live, 3], 204);
  assert.equal(spatialFrames(s, 205).bodyMesh, undefined, "New live cannot use older rest either");
  publish(s, 1, 6n, [...rest, 259], 206);
  assert.ok(spatialFrames(s, 207).bodyMesh);
  publish(s, 1, 7n, [...rest, 511], 208);
  publish(s, 0, 8n, [...live, 255], 209);
  assert.ok(spatialFrames(s, 210).bodyMesh, "Compare selected u8 and u32 at their common width");
  publish(s, 1, 9n, [...rest, 512], 211);
  assert.equal(spatialFrames(s, 212).bodyMesh, undefined);
  publish(s, 0, 10n, [...live, 0], 213);
  assert.ok(spatialFrames(s, 214).bodyMesh, "Wrapping the selected live counter preserves agreement");
});
test("live skin never guesses revisions from unselected companions or another acquisition", () => {
  for (const group of [0, 1]) {
    const s = metaSetup(), sub = s.active.get(group)!, bundle = group;
    const revision = sub.request.bundles[bundle].pop()!;
    const values = sub.packet!.bundles[bundle]!;
    const version = values.pop()!;
    assert.equal(spatialFrames(s, 101).bodyMesh, undefined, `Unselected ${group === 0 ? "live" : "rest"} revision must hide skin`);
    assert.equal(spatialFrames(s, 101).body.active, true);
    // A separately selected revision must come from exactly its poses' acquisition.
    s.request({ id: 2, group, delivery: 1, ...timing(60), sequenceNumberFormat: null, bundles: [[revision]] });
    s.receive({ tag: 5, id: 2 });
    const timestamp = sub.packet!.timestamp;
    publish(s, 2, timestamp - 1n, [version]);
    assert.equal(spatialFrames(s, 101).bodyMesh, undefined, "An older companion cannot validate fresh geometry");
    publish(s, 2, timestamp + 1n, [version]);
    assert.equal(spatialFrames(s, 101).bodyMesh, undefined, "A newer companion cannot validate older geometry");
    publish(s, group, timestamp + 1n, values);
    assert.ok(spatialFrames(s, 101).bodyMesh, "Same-acquisition companion can arrive through a separate subscription");
  }
  const s = metaSetup(), live = s.active.get(0)!, revision = live.request.bundles[0].pop()!;
  live.packet!.bundles[0]!.pop();
  s.request({ id: 2, group: 0, delivery: 1, ...timing(60), sequenceNumberFormat: null, bundles: [[revision]] }); s.receive({ tag: 5, id: 2 });
  publish(s, 2, live.packet!.timestamp, [1], 0);
  // Fresh reception of a previously acquired pose cannot refresh a stale revision.
  live.acquiredAtArrival = 1000; live.bundles[0]!.acquiredAtArrival = 1000;
  assert.equal(spatialFrames(s, 1001).bodyMesh, undefined);
  assert.equal(spatialFrames(s, 1001).body.active, true);
});
test("standalone rest skin has no live subscription dependency", () => {
  const s = metaSetup(); s.stop(0);
  assert.ok(spatialFrames(s, 60_000, true).bodyMesh);
  assert.equal(spatialFrames(s, 60_000).bodyMesh, undefined);
});

test("gripper closure uses its own subscribed and active trigger acquisition", () => {
  for (const [id, trigger] of [["/gamepad/virtual/pose", "/user/gamepad/input/trigger_right/value"], ["/phone/input/grip/pose", "/phone/input/trigger/value"]]) {
    const s = new Session();
    const gamepad = id === "/gamepad/virtual/pose";
    const descriptors = [
      { id, group: 0, kind: 10, formats: [10], spaces: [2] },
      { id: trigger, group: 1, kind: 8, formats: [10], spaces: [] },
      ...(gamepad ? [{ id: trigger + "/active", group: 1, kind: 1, formats: [1], spaces: [] }] : []),
    ].map(d => ({ ...d, name: d.id, description: "" }));
    s.receive({ tag: 2, version: 1 }); s.receive({ tag: 3, capabilities: { groups: [60, 60], descriptors, skeletons: [] } });
    const accept = (group: number, onChange: boolean) => {
      const samples = descriptors.flatMap((d, descriptor) => d.group === group ? [{ descriptor, format: d.formats[0], space: d.spaces[0] ?? 0 }] : []);
      s.request({ id: group, group, delivery: 1, ...timing(60), sequenceNumberFormat: onChange ? 2 : null, bundles: onChange ? [[], samples] : [samples] });
      s.receive({ tag: 5, id: group });
    };
    accept(0, false); accept(1, false);
    const read = (now: number) => spatialFrames(s, now).poses.poses[0].closure;
    assert.equal(read(100), undefined);
    publish(s, 1, 1n, gamepad ? [0.75, true] : [0.75]);
    assert.equal(read(101), 0.75);
    assert.equal(read(1000), undefined, "Stale continuous trigger");
    if (gamepad) {
      publish(s, 1, 2n, [1, false]);
      assert.equal(read(101), undefined, "Inactive right trigger");
    }
    s.stop(1); s.receive({ tag: 8, id: 1, reason: "Replaced" });
    assert.equal(read(101), undefined);
    accept(1, true);
    publish(s, 1, 3n, gamepad ? [0.25, true] : [0.25]);
    assert.equal(read(10_000), 0.25, "A quiet on-change control retains its last measurement");
  }
});

test("body-facing view cancels global yaw and translation for skeleton, mesh and controller", () => {
  const s = metaSetup(), c = structuredClone(s.capabilities!);
  c.descriptors[0].id = "/body/FB/10"; // left anatomical shoulder pivot
  c.descriptors[1].id = "/body/FB/15"; // right; advertised first in this skeleton
  c.descriptors[1].spaces = [2];
  c.descriptors.push({ ...c.descriptors[1], id: "/user/hand/right/input/grip/pose" });
  s.capabilities = c;
  const sub = s.active.get(0)!;
  sub.request.bundles[0][1].space = 2;
  sub.request.bundles[0].push({ descriptor: 8, format: 10, space: 2 });
  const relative = () => spatialFrames(s, 101, false, new Set(), true);
  const identity = [0, 0, 0, 1], turn = [0, Math.SQRT1_2, 0, Math.SQRT1_2], roll = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  // A +90° world yaw carries the anatomical right axis towards -Z.
  const send = (left: number[], right: number[], grip: number[], valid = true) =>
    publish(s, 0, BigInt(3 + sub.packets), [left, right, valid, true, 1, grip]);
  const close = (actual: number[], expected: number[]) =>
    actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-6, `${actual} vs ${expected}`));
  send([-.2, 1.5, 0, ...identity], [.2, 1.7, 0, ...identity], [.4, 1.1, -.6, ...roll]);
  const first = relative();
  close(first.poses.poses[0].position, [.4, -.5, -.6]);
  close(first.body.poses[0].position, [.2, .1, 0]);
  const secondGrip = [2.4, 3.1, 3.6, .5, .5, .5, .5]; // world yaw × controller roll
  send([3, 3.5, 4.2, ...turn], [3, 3.7, 3.8, ...turn], secondGrip);
  const second = relative();
  assert.equal(second.missingReference, false);
  close(second.poses.poses[0].position, first.poses.poses[0].position);
  close(second.poses.poses[0].orientation, roll);
  for (const [i, p] of second.body.poses.entries()) {
    close(p.position, first.body.poses[i].position);
    close(p.orientation, identity);
    close(second.bodyMesh!.sample.poses[i].position, p.position);
  }
  assert.deepEqual(second.bodyMesh!.skeleton, first.bodyMesh!.skeleton);
  close(spatialFrames(s, 101).poses.poses[0].position, secondGrip.slice(0, 3));
  const unavailable = () => {
    const view = relative();
    assert.equal(view.missingReference, true); assert.equal(view.body.active, false);
    assert.equal(view.bodyMesh, undefined); assert.deepEqual(view.sources, []);
  };
  send([3, 3.5, 4.2, ...turn], [3, 3.7, 3.8, ...turn], secondGrip, false);
  unavailable(); // invalid shoulder
  send([1, 0, 0, ...turn], [1, .4, 0, ...turn], secondGrip);
  unavailable(); // shoulder line vertical
  send([1, 0, 0, ...turn], [2, 0, 0, ...turn], secondGrip);
  assert.equal(relative().missingReference, false, "Valid tracking recovers automatically");
  assert.equal(spatialFrames(s, 1000, false, new Set(), true).missingReference, true, "Stalled samples cannot provide a reference");
  sub.request.bundles[0].at(-1)!.space = 3;
  unavailable(); // controller in a different reference space
  sub.request.bundles[0].at(-1)!.space = 2;
  s.request({ ...sub.request, id: 5, bundles: [[sub.request.bundles[0][1]]] });
  s.receive({ tag: 5, id: 5 });
  publish(s, 5, 42n, [[2, 0, 0, ...turn]]);
  unavailable(); // latest right position and left position describe different acquisitions
  assert.equal(spatialFrames(s, 101, true, new Set(), true).body.active, true, "Rest keeps its own frame");
});
