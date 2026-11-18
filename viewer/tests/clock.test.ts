import assert from "node:assert/strict";
import { test } from "node:test";
import { SoftwareClock } from "../src/clock";
const ns = (ms: number) => BigInt(Math.round(ms*1e6));
const origin = 9_007_199_254_740_993n;
function probe(clock: SoftwareClock, at: number, drift: number, phaseMs=0, forward=1, backward=1) {
  const actual=(ms:number)=>origin+ns(ms*(1+drift)+phaseMs);
  const t1=clock.capture(at), t2=actual(at+forward), t3=t2, t4=clock.capture(at+forward+backward);
  clock.observe(t1,t2,t3,t4,at+forward+backward);
  return Number(clock.capture(at+forward+backward)-actual(at+forward+backward))/1e6;
}
test("clock aligns with a low-delay observation while preserving integer origin precision",()=>{
  const c=new SoftwareClock();
  for(let i=0;i<4;i++) probe(c,i*250,0,0, i===1?30:1,1);
  assert.equal(c.aligned,true);assert.equal(c.offset,origin);
});
test("250 ms clock probes learn positive/negative rates and retain phase/rate through response loss",()=>{
  for(const drift of [-0.0002,0.0002]){
    const c=new SoftwareClock();let error=0;
    for(let i=0;i<2400;i++)error=probe(c,i*250,drift);
    assert.ok(Math.abs(error)<0.1,`steady error ${error} ms`);
    assert.ok(Math.abs(c.rate-drift)<0.00001,`rate ${c.rate}`);
    const rate=c.rate;
    for(let i=2400;i<2480;i++) c.capture(i*250);
    const actual=origin+ns(620000*(1+drift));
    assert.ok(Math.abs(Number(c.capture(620000)-actual)/1e6)<0.3,"20 seconds of holdover preserves frequency");
    assert.equal(c.rate,rate);
    for(let i=2481;i<2880;i++)error=probe(c,i*250,drift,1);
    assert.ok(Math.abs(error)<0.15,`phase convergence ${error} ms`);
  }
});
test("isolated asymmetric spikes do not replace learned frequency",()=>{
  const c=new SoftwareClock();for(let i=0;i<800;i++)probe(c,i*250,0.0001);
  const before=c.rate;probe(c,200000,0.0001,0,80,1);
  assert.ok(Math.abs(c.rate-before)<0.000001);
  let error=0;for(let i=801;i<900;i++)error=probe(c,i*250,0.0001);
  assert.ok(Math.abs(error)<0.1);
});
test("a confirmed clock-origin step reinitializes phase and rate before realigning",()=>{
  const c=new SoftwareClock();for(let i=0;i<100;i++)probe(c,i*250,0);
  for(let i=100;i<110;i++)probe(c,i*250,0,2000);
  assert.equal(c.aligned,true);assert.equal(c.offset,origin+2_000_000_000n);assert.equal(c.rate,0);
});

test("an isolated low-delay spike cannot confirm itself on the next ordinary response", () => {
  const c=new SoftwareClock(); for(let i=0;i<800;i++) probe(c,i*250,0);
  probe(c,200000,0,5,0.25,0.25);
  assert.equal(c.rate,0); assert.equal(c.phase,0);
  probe(c,200250,0);
  assert.equal(c.rate,0); assert.equal(c.phase,0); assert.equal(c.offset,origin);
  for(let i=802;i<820;i++) probe(c,i*250,0);
  assert.equal(c.offset,origin);
  // A distinct observation can corroborate a persistent step.
  probe(c,205000,0,5,0.25,0.25); probe(c,205250,0,5,0.25,0.25);
  assert.ok(c.phase>0.0049); assert.ok(c.rate>0);
});

test("four-timestamp observations clamp delay to the supplied browser precision", () => {
  for(const precision of [100_000n,2_000_000n]) {
    const c=new SoftwareClock(precision);
    const {observation}=c.observe(1000n,1200n,1300n,1300n,0.0013);
    assert.equal(observation.residualNs,100n); assert.equal(observation.delay,precision);
  }
  const c=new SoftwareClock(); assert.equal(c.precisionNs,100_000n);
  const result=c.observe(1000n,1200n,1300n,1050n,0.00105);
  assert.equal(result.observation.delay,100_000n);
  assert.equal(result.observation.residualNs,225n);
});

test("estimate snapshots are explicit, immutable mappings independent of earlier queries", () => {
  const first=new SoftwareClock(), second=new SoftwareClock();
  for(let i=0;i<800;i++){probe(first,i*250,0.0001);probe(second,i*250,0.0001);}
  const before=first.estimate(200000)!, offset=before.offset;
  first.estimate(200250);
  assert.equal(before.offset,offset,"Reading a later mapping cannot mutate an earlier snapshot");
  assert.ok(Math.abs(Number(first.estimate(200500)!.offset-second.estimate(200500)!.offset))<=1);
});


test("phase integration is independent of frame cadence through clipping and holdover", () => {
  for (const phase of [-0.005, -0.0005, 0.0005, 0.005]) {
    const frequent=new SoftwareClock(), sparse=new SoftwareClock();
    for(const clock of [frequent,sparse]) { clock.advance(0); clock.phase=phase; clock.rate=0.0001; }
    for(let i=1;i<2000;i++) frequent.advance(i*16.7);
    frequent.advance(35000); sparse.advance(35000);
    assert.ok(Math.abs(Number(frequent.offset-sparse.offset))<=1, `phase ${phase}`);
    assert.ok(Math.abs(frequent.phase-sparse.phase)<1e-12);
    const offset=frequent.offset;
    frequent.advance(34000); frequent.advance(35000);
    assert.equal(frequent.offset,offset,"An earlier mapping query cannot replay elapsed time");
  }
});
