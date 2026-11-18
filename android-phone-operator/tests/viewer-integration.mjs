import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createServer} from 'node:net';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const viewer = resolve(process.env.VIEWER_ROOT || resolve(root, '../viewer'));
const require=createRequire(resolve(viewer,'package.json'));
const {chromium}=require('playwright-core');
const binaries = {
  orientation: 'phone-operator-synthetic',
  spatial: 'phone-operator-spatial-synthetic',
  displacement: 'phone-operator-displacement-synthetic',
};
for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(binaries)) {
  assert.ok(Object.hasOwn(binaries, mode), 'Expected orientation, spatial, or displacement');
  await run(mode);
}

async function run(mode) {
  let serverPort,viewerPort,url;
  const children=[];
  const start=(bin,args,options)=>{
    const p=spawn(bin,args,{stdio:['ignore','pipe','pipe'],...options});children.push(p);p.output='';
    p.stdout.on('data',b=>{p.output+=b.toString();process.stdout.write(b);});
    p.stderr.on('data',b=>process.stderr.write(b));return p;
  };
  const ready=async(p,pattern)=>{
    const end=Date.now()+15000;
    while(Date.now()<end){
      if(p.exitCode!==null||p.signalCode!==null)throw Error(`Owned child ${p.pid} exited before readiness`);
      const match=p.output.match(pattern);if(match)return match;
      await new Promise(r=>setTimeout(r,25));
    }
    throw Error(`Owned child ${p.pid} readiness timeout`);
  };
  const unusedPort=async()=>{
    const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
    const port=reservation.address().port;await new Promise((resolve,reject)=>reservation.close(e=>e?reject(e):resolve()));return port;
  };
  const wait=async(fn)=>{const end=Date.now()+15000;while(Date.now()<end){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Startup timeout');};
  let browser;
  try {
    const source=start(resolve(root, 'target/debug', binaries[mode]),['--port','0']);
    const sourceReady=await ready(source,/SYNTHETIC [^\n]+ server http:\/\/127\.0\.0\.1:(\d+)/);
    serverPort=Number(sourceReady[1]);
    await wait(async()=>{if(source.exitCode!==null)throw Error('Owned source exited');const r=await fetch(`http://127.0.0.1:${serverPort}/health`);return r.ok&&(await r.json()).source.startsWith('SYNTHETIC ');});
    viewerPort=await unusedPort();url=`http://127.0.0.1:${viewerPort}`;
    const vite=start(process.execPath,[resolve(viewer,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(viewerPort),'--strictPort'],{cwd:viewer,env:{...process.env,NO_COLOR:'1',XR_OPERATOR_URL:`http://127.0.0.1:${serverPort}`}});
    // Require the owned Vite process to bind; a competing process cannot satisfy readiness.
    await ready(vite,new RegExp(`Local:.*http://127\\.0\\.0\\.1:${viewerPort}/`));
    await wait(async()=> (await fetch(url)).ok);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/opt/google/chrome/chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1400,height:1000}});
    await page.goto(url);
    const normal=await page.evaluate(async mode=>{
      const {Connection}=await import('/src/connection.ts');
      const {currentValues,poseSources,spatialFrames}=await import('/src/tracking-view.ts');
      const seen=new Set(),errors=[];let packets=0,rawMeasurements=0,closedFormChecks=0;
      const previous = new Map();
      const gravity = mode === 'displacement' ? 9.80665 : 9.81;
      const c=new Connection(state=>{if(state.status==='Error')errors.push(state.detail);});
      try {
        await c.connect();const end=performance.now()+11000;
        while(performance.now()<end){
          if(errors.length)throw Error(errors.join(';'));
          if(c.session.phase==='ready'){
            const values=currentValues(c.session,performance.now()),caps=c.session.capabilities;
            const active=[];
            for(const [index,d] of caps.descriptors.entries()){
              if(d.id.endsWith('/phone/accelerometer/y')){
                const v=values.get(index),valid=values.get(index+1);
                if(valid?.value===true){if(v.packet.timestamp!==valid.packet.timestamp||Math.abs(v.value-gravity)>0.0001)throw Error('Raw measurement/validity mismatch');rawMeasurements++;}
              }
              if(d.kind!==10)continue;const sample=values.get(index),quality=values.get(d.orientation_valid_sample),position=values.get(d.position_valid_sample);
              if(!sample?.packet)continue;
              if(position?.value !== (mode === 'orientation' ? false : quality?.value)) throw Error('Incorrect position validity');
              if(quality?.value===true){
                if(sample.packet.timestamp!==quality.packet.timestamp)throw Error('Mismatched orientation acquisition');
                const [x,y,z] = sample.value;
                const tracked = values.get(d.position_tracked_sample);
                if (tracked?.value !== (mode === 'spatial') || tracked.packet.timestamp !== sample.packet.timestamp)
                  throw Error('Incorrect position tracking');
                if (position.packet.timestamp !== sample.packet.timestamp) throw Error('Position timestamp mismatch');
                if (mode === 'orientation' && (x || y || z)) throw Error('Invented position');
                if (mode === 'spatial' && (Math.abs(z+0.3)>0.0001 || Math.abs(x)>0.251 || y<0.149 || y>0.251))
                  throw Error('Wrong synthetic spatial position');
                if (mode === 'displacement') {
                  if (!sample.value.every(Number.isFinite) || x<0 || x>0.5 || Math.abs(y)>0.0001 || Math.abs(z)>0.0001)
                    throw Error('Wrong displacement');
                  const prior = previous.get(d.id), t = sample.packet.timestamp;
                  if (prior && x>prior.x && prior.x>0.00001 && t>prior.t) {
                    // The fixture accelerates from rest at 0.2 m/s², so x=0.1t².
                    if (Math.abs(Math.sqrt(x/0.1)-Math.sqrt(prior.x/0.1)-Number(t-prior.t)/1e9)>0.003)
                      throw Error('Displacement/time mismatch');
                    closedFormChecks++;
                  }
                  previous.set(d.id, {x,t});
                }
                active.push(poseSources.get(d.id));
              }
            }
            if(active.length>1)throw Error('Both hands active');
            const view = spatialFrames(c.session, performance.now());
            const flags = mode === 'orientation' ? 5 : mode === 'spatial' ? 15 : 7;
            if (view.sources.length !== active.length || view.poses.poses.some(p=>p.flags !== flags))
              throw Error('Viewer pose/quality mismatch');
            if(active.length)seen.add(active[0]);else seen.add('inactive');
            for(const sub of c.session.active.values()){if(sub.packet?.predictedFor!=null)throw Error('Invented prediction');packets=Math.max(packets,sub.packets);}
          }
          await new Promise(r=>setTimeout(r,25));
        }
        return {seen:[...seen],groups:c.session.active.size,descriptors:c.session.capabilities?.descriptors.length,clock:!!c.session.clockEstimate(performance.now()),packets,rawMeasurements,closedFormChecks,errors};
      }finally{c.close();}
    },mode);
    if (mode === 'displacement') assert.ok(normal.closedFormChecks > 0);
    assert.deepEqual(normal.seen.sort(),['inactive','left/grip','right/grip']);assert.equal(normal.groups,4);assert.equal(normal.clock,true);assert.ok(normal.packets>0);assert.ok(normal.rawMeasurements>0);assert.deepEqual(normal.errors,[]);
    const protocol=await page.evaluate(async()=>{
      const {Session}=await import('/src/session.ts');const {timing,decodeTracking}=await import('/src/protocol.ts');
      const s=new Session(),pc=new RTCPeerConnection({iceServers:[]});
      const reliable=pc.createDataChannel('reliable',{ordered:true,protocol:'xrop'}),unreliable=pc.createDataChannel('unreliable',{ordered:false,maxRetransmits:0,protocol:'xrop'});
      const errors=[],wire=new Map(),reports=[];let drop=true;
      const pause=ms=>new Promise(r=>setTimeout(r,ms));
      const wait=async(predicate,label)=>{let end=performance.now()+10000;while(!predicate()){if(errors.length)throw Error(errors.join(';'));if(performance.now()>end)throw Error('Timeout '+label+' '+s.detail);await pause(10);}};
      for(const dc of [reliable,unreliable]){dc.binaryType='arraybuffer';dc.onmessage=e=>{try{
        const bytes=new Uint8Array(e.data);
        if(bytes[0]===9){const id=new DataView(bytes.buffer).getUint32(1,true),request=s.active.get(id)?.request;if(request){const list=wire.get(id)||[];list.push(decodeTracking(bytes.subarray(1),s.capabilities,request));wire.set(id,list);}}
        if(dc===reliable)s.control(bytes,performance.now());else s.unreliable(bytes,performance.now());
        for(const ack of s.takeAcknowledgments())if(!drop)unreliable.send(ack);
      }catch(e){errors.push(String(e));}};}
      try {
        await pc.setLocalDescription(await pc.createOffer());await wait(()=>pc.iceGatheringState==='complete','ICE');
        const answer=await fetch('/api/offer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pc.localDescription)});if(!answer.ok)throw Error('Signaling '+answer.status);
        await pc.setRemoteDescription(await answer.json());await wait(()=>reliable.readyState==='open'&&unreliable.readyState==='open','channels');
        reliable.send(s.start());await wait(()=>s.phase==='ready','negotiation');
        const c=s.capabilities;const index=c.descriptors.findIndex(d=>d.id==='/user/hand/left/input/grip/pose/position_valid');if(index<0)throw Error('Standard pose missing');
        const binding={descriptor:index,format:1,space:0};
        for(const delivery of [1,2]){
          const id=s.allocateId(),request={id,group:0,delivery,...timing(50,7_000_000n,35_000_000n),sequenceNumberFormat:2,bundles:[[],[binding]]};
          drop=true;reliable.send(s.request(request));await wait(()=>s.active.get(id)?.packets>=3,'lost ACK repeats');
          const entries=wire.get(id);if(new Set(entries.map(p=>String(p.sequenceNumber))).size!==entries.length)throw Error('Reused sequence');
          drop=false;await pause(100);const sub=s.active.get(id),settled=sub.packets;await pause(120);if(sub.packets!==settled)throw Error('ACK failed to quiesce');
          reliable.send(s.changeSchedule(id,timing(100,11_000_000n,60_000_000n)));await pause(100);if(sub.packets!==settled)throw Error('Timing reset ACK state');
          const invalid=s.request(request);new DataView(invalid.buffer).setUint32(5,99,true);reliable.send(invalid);await wait(()=>!s.pending.has(id),'rejection');if(s.active.get(id)!==sub||!s.detail.includes('rejected'))throw Error('Rejected replacement changed active');
          reports.push({delivery,packets:settled,predictedFor:sub.packet.predictedFor});
          reliable.send(s.stop(id));await wait(()=>!s.stopping.has(id),'unsubscribe');
        }
        const id=s.allocateId(),r={id,group:0,delivery:1,...timing(50),sequenceNumberFormat:1,bundles:[[binding],[binding]]};
        reliable.send(s.request(r));await wait(()=>s.active.get(id)?.packets>=6,'mixed bundles');if(!wire.get(id).some(p=>p.bundles[1]===null))throw Error('ACKed bundle not omitted');
        reliable.send(s.request({...r,delivery:2}));await wait(()=>s.active.get(id)?.request.delivery===2&&s.active.get(id)?.packets>=2,'replacement');
        reliable.send(s.changeSchedule(id,{...timing(50),interval:1n}));await wait(()=>!s.active.has(id),'rate rejection ends active');
        for(let i=0;i<4;i++){unreliable.send(s.requestClock(performance.now()));await pause(100);}await wait(()=>!!s.clockEstimate(performance.now()),'clock');
        return {reports,clock:true,errors};
      }finally{pc.close();s.retire();}
    });
    assert.deepEqual(protocol.errors,[]);assert.ok(protocol.reports.every(r=>r.predictedFor===null&&r.packets>=3));
    // Exercise the unchanged production UI, using its ordinary connect action.
    await page.getByRole('button',{name:'Connect',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Connected');
    await page.waitForFunction(()=>document.querySelector('#poses')?.dataset.poseCount==='1');
    if (mode === 'orientation')
      await page.waitForFunction(()=>document.querySelector('#poses')?.dataset.poseCount==='0');
    // The current editor displays one acquisition group's subscription at a time.
    await page.locator('subscription-editor [data-action="select"][data-group="0"]').first().click();
    for(const hand of ['left','right']) {
      const poseRow=`tr[data-descriptor="/user/hand/${hand}/input/grip/pose"]`;
      await page.locator(poseRow).scrollIntoViewIfNeeded();
      await page.waitForFunction(({selector,mode})=>{
        const row = document.querySelector(selector);
        const status = row?.querySelector('.binding-state')?.textContent;
        const values = row?.querySelector('.sample-value')?.textContent.split(',').map(Number);
        if (row?.dataset.available !== 'true' || values?.length !== 7 ||
            Math.abs(values.slice(3).reduce((sum,n)=>sum+n*n,0)-1)>=0.003) return false;
        if (mode === 'orientation') return status === 'Position invalid' && values.slice(0,3).every(n=>n===0);
        if (mode === 'spatial') return Math.abs(values[2]+0.3)<0.003;
        return values[0]>0.001 && Math.abs(values[1])<0.003 && Math.abs(values[2])<0.003;
      },{selector:poseRow,mode});
    }
    await page.locator('subscription-editor [data-action="select"][data-group="1"]').first().click();
    const rawRow='tr[data-descriptor="/user/hand/left/phone/accelerometer/y"]';
    await page.locator(rawRow).scrollIntoViewIfNeeded();
    await page.waitForFunction(selector=>document.querySelector(selector)?.dataset.available==='true',rawRow);
    console.log('PASS '+mode+' viewer integration',JSON.stringify({normal,protocol},(_,v)=>typeof v==='bigint'?v.toString():v));
  } finally {
    if(browser)await browser.close();
    for(const p of children.reverse()){
      if(p.exitCode!==null)continue;
      const exited=once(p,'exit');p.kill('SIGINT');
      const timer=setTimeout(()=>p.kill('SIGKILL'),5000);
      await exited;clearTimeout(timer);
    }
  }
}
