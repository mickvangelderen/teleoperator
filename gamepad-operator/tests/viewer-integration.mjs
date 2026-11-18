// Current viewer integration; all servers, ports and browser handles are owned/reaped.
// Synthetic input only: no physical controller is opened.
// Run: VIEWER_ROOT=/path/to/isolated/viewer node tests/viewer-integration.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createServer} from 'node:net';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const viewer=process.env.VIEWER_ROOT;
assert.ok(viewer,'VIEWER_ROOT must name an isolated viewer checkout/copy');
const require=createRequire(resolve(viewer,'package.json'));
const {chromium}=require('playwright-core');
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
  const source=start(resolve(root,'target/debug/gamepad-operator'),['--synthetic','--listen','127.0.0.1:0',...(process.env.LIFECYCLE?['--synthetic-lifecycle']:[]),...(process.env.VIRTUAL?['--virtual-pose','--synthetic-virtual-demo']:[])]);
  const sourceReady=await ready(source,/Gamepad Operator SYNTHETIC http:\/\/127\.0\.0\.1:(\d+)/);
  serverPort=Number(sourceReady[1]);
  await wait(async()=>{if(source.exitCode!==null)throw Error('Owned source exited');const r=await fetch(`http://127.0.0.1:${serverPort}/health`);return r.ok&&(await r.json()).selected?.device.synthetic===true;});
  viewerPort=await unusedPort();url=`http://127.0.0.1:${viewerPort}`;
  const vite=start(process.execPath,[resolve(viewer,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(viewerPort),'--strictPort'],{cwd:viewer,env:{...process.env,NO_COLOR:'1',XR_OPERATOR_URL:`http://127.0.0.1:${serverPort}`}});
  // Require the owned Vite process to bind; a competing process cannot satisfy readiness.
  await ready(vite,new RegExp(`Local:.*http://127\\.0\\.0\\.1:${viewerPort}/`));
  await wait(async()=> (await fetch(url)).ok);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/opt/google/chrome/chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:1000}});
  await page.goto(url);
  await page.getByRole('dialog').getByLabel('Operator address').fill(`http://127.0.0.1:${serverPort}`);
  if(process.env.VIRTUAL && !process.env.LIFECYCLE) {
    await verifyVirtual(page);
  } else if(process.env.LIFECYCLE) {
    const lifecycle=await page.evaluate(async(virtual)=>{
      const {Connection}=await import('/src/connection.ts');
      const {currentValues}=await import('/src/tracking-view.ts');
      const pause=ms=>new Promise(r=>setTimeout(r,ms));
      const c=new Connection(()=>{});let replacement;
      let inactive=false,beforeRelease=0n,disconnectAt;
      try {
        await c.connect();const end=performance.now()+13000;
        while(performance.now()<end && c.state.status!=='Error') {
          if(c.session.capabilities) {
            const caps=c.session.capabilities,values=currentValues(c.session,performance.now());
            const get=id=>values.get(caps.descriptors.findIndex(d=>d.id===id));
            const connected=get('/gamepad/connected');
            const releases=BigInt(get('/user/gamepad/input/a/click/release_count')?.value??0);
            if(connected?.value===false) {
              inactive=true;disconnectAt=String(connected.packet.timestamp);
              if(releases!==beforeRelease)throw Error('Disconnect manufactured a release edge');
              for(const [i,d] of caps.descriptors.entries()) if(d.id.endsWith('/active')) {
                const value=values.get(i);if(value?.value!==false||value.packet.timestamp!==connected.packet.timestamp)throw Error('Input remained valid after disconnect');
              }
              if(virtual) {
                const pose=get('/gamepad/virtual/pose');
                if(pose.value.some((n,i)=>n!==(i===6?1:0)))throw Error('Disconnected virtual pose not an identity placeholder');
                for(const name of ['position_valid','orientation_valid','position_tracked','orientation_tracked']) {
                  const quality=get('/gamepad/virtual/pose/'+name);
                  if(quality.value!==false||quality.packet.timestamp!==pose.packet.timestamp)throw Error('Disconnected virtual quality was not false/matched');
                }
                if(get('/gamepad/virtual/enabled').value!==false)throw Error('Disconnect did not pause virtual pose');
              }
              const stick=get('/user/gamepad/input/thumbstick_left');
              if(stick.value.some(n=>n!==0))throw Error('Disconnected stick not a qualified zero placeholder');
            } else if(connected?.value===true)beforeRelease=releases;
          }
          await pause(15);
        }
        if(!inactive)throw Error('Disconnected sample was not observed');
        if(c.state.status!=='Error')throw Error('Old epoch remained connected after device reconnect');
        replacement=new Connection(()=>{});await replacement.connect();
        const deadline=performance.now()+1500;let reset=false;
        while(performance.now()<deadline) {
          if(replacement.session.capabilities) {
            const values=currentValues(replacement.session,performance.now());
            const caps=replacement.session.capabilities;
            const counter=caps.descriptors.findIndex(d=>d.id==='/user/gamepad/input/a/click/press_count');
            // Negotiation creates pending entries before their first sample arrives.
            if(values.get(counter)?.packet){
              if(!caps.descriptors.every((_,i)=>values.get(i)?.packet))throw Error('Reconnect did not deliver full state');
              reset=BigInt(values.get(counter).value)===0n;
              if(virtual) {
                const enabled=caps.descriptors.findIndex(d=>d.id==='/gamepad/virtual/enabled');
                if(values.get(enabled)?.value!==false)throw Error('New epoch automatically resumed virtual motion');
              }
              break;
            }
          }
          await pause(10);
        }
        if(!reset)throw Error('New connection did not establish fresh counter epoch');
        return {inactive,disconnectAt,closedOldEpoch:true,newHandshake:true,countersReset:true,virtualPaused:virtual};
      }finally{c.close();replacement?.close();}
    },!!process.env.VIRTUAL);
    console.log('PASS gamepad lifecycle',JSON.stringify(lifecycle));
  } else {
  const normal=await page.evaluate(async()=>{
    const {Connection}=await import('/src/connection.ts');
    const {currentValues}=await import('/src/tracking-view.ts');
    const errors=[],buttonStates=new Set();let packets=0,samples=0,presses=0n,releases=0n,initialCounts;
    let quietSince=0,longestQuiet=0;
    const c=new Connection(state=>{if(state.status==='Error')errors.push(state.detail);});
    try {
      await c.connect();const end=performance.now()+5500;
      while(performance.now()<end){
        if(errors.length)throw Error(errors.join(';'));
        if(c.session.phase==='ready'){
          const values=currentValues(c.session,performance.now()),caps=c.session.capabilities;
          if(caps.descriptors.some(d=>d.kind===10))throw Error('Physical pose advertised');
          const byId=id=>{const i=caps.descriptors.findIndex(d=>d.id===id);return values.get(i);};
          for(const [id,expected] of [['/user/gamepad/input/thumbstick_left',[0.5,-0.25]],['/user/gamepad/input/trigger_left/value',0.25]]){
            const v=byId(id),active=byId(id+'/active');
            if(v?.packet){
              if(active?.value!==true || v.packet.timestamp!==active.packet.timestamp)throw Error('Invalid/mismatched activity');
              const a=Array.isArray(v.value)?v.value:[v.value],b=Array.isArray(expected)?expected:[expected];
              if(a.some((n,i)=>Math.abs(n-b[i])>0.01))throw Error('Incorrect normalized input');samples++;
            }
          }
          const button=byId('/user/gamepad/input/a/click');
          if(button?.packet){
            buttonStates.add(button.value);
            presses=BigInt(byId('/user/gamepad/input/a/click/press_count').value);
            releases=BigInt(byId('/user/gamepad/input/a/click/release_count').value);
            initialCounts??=[presses,releases];
            if(button.stale)throw Error('Acknowledged idle input marked stale');
          }
          for(const sub of c.session.active.values()){
            const bundles=sub.request.bundles;
            if(bundles.length!==2 || bundles[0].length || bundles[1].length!==caps.descriptors.length ||
              sub.request.sequenceNumberFormat===null || !c.isAutomatic(sub.request.id))throw Error('Wrong raw default subscription');
            if(sub.packet?.predictedFor!=null)throw Error('Invented prediction');
            if(sub.packet){
              if(sub.packets!==packets){quietSince=performance.now();packets=sub.packets;}
              longestQuiet=Math.max(longestQuiet,performance.now()-quietSince);
            }
          }
        }
        await new Promise(r=>setTimeout(r,25));
      }
      return {groups:c.session.active.size,descriptors:c.session.capabilities?.descriptors.length,clock:!!c.session.clockEstimate(performance.now()),packets,samples,longestQuiet,
        buttonStates:[...buttonStates],presses:String(presses-initialCounts[0]),releases:String(releases-initialCounts[1]),
        freshnessStreams:c.session.freshness(performance.now()).streams.length,errors};
    }finally{c.close();}
  });
  assert.equal(normal.groups,1);assert.equal(normal.clock,true);assert.equal(normal.freshnessStreams,0);
  assert.ok(normal.longestQuiet>500);assert.equal(normal.buttonStates.length,2);assert.ok(normal.samples>0);
  assert.ok(BigInt(normal.presses)>0n);assert.ok(BigInt(normal.releases)>0n);assert.deepEqual(normal.errors,[]);
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
      const c=s.capabilities;const index=c.descriptors.findIndex(d=>d.id==='/gamepad/connected');if(index<0)throw Error('Connection status missing');
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
      // The scripted A button goes down and up once per four seconds. Lengthen the
      // slot after a release so the next complete press falls between publications.
      const buttonId=s.allocateId(),a=c.descriptors.findIndex(d=>d.id==='/user/gamepad/input/a/click');
      const {press_count_sample,release_count_sample}=c.descriptors[a];
      const selected=[a,press_count_sample,release_count_sample].map(descriptor=>({
        descriptor,format:c.descriptors[descriptor].formats[0],space:0
      }));
      reliable.send(s.request({id:buttonId,group:0,delivery:1,...timing(60),sequenceNumberFormat:2,bundles:[[],selected]}));
      const buttonPackets=()=>wire.get(buttonId)??[];
      await wait(()=>buttonPackets().some(p=>p.bundles[1][0]),'A down');
      await wait(()=>buttonPackets().at(-1).bundles[1][0]===false,'A released');
      const released=buttonPackets().at(-1),start=buttonPackets().length;
      const slow=timing(0.2);
      reliable.send(s.changeSchedule(buttonId,{...slow,phase:released.timestamp%slow.interval}));
      await wait(()=>buttonPackets().at(-1).timestamp>released.timestamp+4_500_000_000n,'slot following a complete press');
      const after=buttonPackets().at(-1).bundles[1],before=released.bundles[1];
      if(buttonPackets().slice(start).some(p=>p.bundles[1][0]) ||
        Number(after[1])!==Number(before[1])+1 || Number(after[2])!==Number(before[2])+1)throw Error('Between-slot A edges lost');
      reliable.send(s.stop(buttonId));await wait(()=>!s.stopping.has(buttonId),'stop slow slots');
      for(let i=0;i<4;i++){unreliable.send(s.requestClock(performance.now()));await pause(100);}await wait(()=>!!s.clockEstimate(performance.now()),'clock');
      return {reports,clock:true,betweenSlots:{held:after[0],pressDelta:Number(after[1])-Number(before[1]),releaseDelta:Number(after[2])-Number(before[2])},errors};
    }finally{pc.close();s.retire();}
  });
  assert.deepEqual(protocol.errors,[]);assert.ok(protocol.reports.every(r=>r.predictedFor===null&&r.packets>=3));
  // Exercise production controls, including adding an acknowledged bundle and applying replacement.
  await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();
  // The editor rebuilds its pending rows when the default subscription is accepted.
  // Wait for the live table before scrolling its independently scrollable viewport.
  await page.waitForFunction(()=>document.querySelector('subscription-editor .subscription-message')?.textContent.includes('packets'));
  assert.equal(await page.locator('#status').innerText(),'Connected');
  assert.match(await page.locator('#sample-summary').innerText(),new RegExp('^'+normal.descriptors+' samples'));
  const editor=page.locator('subscription-editor');
  assert.match(await editor.locator('[data-bundle-index="0"] summary').innerText(),/0 bindings/);
  assert.match(await editor.locator('[data-bundle-index="1"] summary').innerText(),new RegExp('On change[\\s\\S]*'+normal.descriptors+' bindings'));
  const stickRow='tr[data-descriptor="/user/gamepad/input/thumbstick_left"]';
  // Live samples replace rows while rendering; query and scroll the current row
  // in one browser task instead of retaining an element across layout frames.
  const scrollRow=selector=>page.waitForFunction(selector=>{
    const row=document.querySelector(selector);if(!row)return false;
    row.scrollIntoView({block:'center'});return true;
  },selector);
  const button='/user/gamepad/input/a/click';
  await scrollRow('tr[data-descriptor="'+button+'"]');
  const buttonReading=async(held,minimumPresses=0,minimumReleases=0)=>{
    const handle=await page.waitForFunction(({button,held,minimumPresses,minimumReleases})=>{
      const read=suffix=>document.querySelector('[data-descriptor="'+button+suffix+'"] .sample-value')?.textContent;
      const presses=parseInt(read('/press_count'),10),releases=parseInt(read('/release_count'),10);
      if(read('')===String(held) && presses>=minimumPresses && releases>=minimumReleases)return {held,presses,releases};
    },{button,held,minimumPresses,minimumReleases});
    return handle.jsonValue();
  };
  const baseline=await buttonReading(false);
  const down=await buttonReading(true,baseline.presses+1,baseline.releases);
  const up=await buttonReading(false,down.presses,down.releases+1);
  await scrollRow(stickRow);
  await page.waitForFunction(selector=>{
    const row=document.querySelector(selector);const v=row?.querySelector('.sample-value')?.textContent.split(',').map(Number);
    return row?.dataset.available==='true' && v?.length===2 && Math.abs(v[0]-0.5)<0.01 && Math.abs(v[1]+0.25)<0.01;
  },stickRow);
  await editor.locator('[data-field="automatic"]').uncheck();
  await editor.locator('[data-field="delivery"]').selectOption('2');
  await editor.locator('[data-action="add-bundle"]').click();
  const bundle=editor.locator('[data-bundle-index="2"]');
  await bundle.locator('[data-action="catalogue"]').click();
  await bundle.locator('[data-field="search"]').fill('/user/gamepad/input/trigger_left/value');
  await bundle.locator('[data-action="add-matches"]').click();
  await editor.locator('[data-action="close-catalogue"]').click();
  await editor.locator('[data-action="apply"]').click();
  await page.waitForFunction(()=>document.querySelector('subscription-editor .subscription-message')?.textContent.includes('packets'));
  await scrollRow('[data-bundle-index="2"] tr[data-descriptor="/user/gamepad/input/trigger_left/value"]');
  await page.waitForFunction(()=>{
    const row=document.querySelector('[data-bundle-index="2"] tr[data-descriptor="/user/gamepad/input/trigger_left/value"]');
    return row?.dataset.available==='true' && Math.abs(Number(row.querySelector('.sample-value')?.textContent)-0.25)<0.01;
  });
  const picker = page.getByRole('combobox', {name:'Visualization', exact:true});
  await picker.selectOption('values');
  const inspector = page.locator('#sample-inspector');
  const accepted = inspector.locator('.inspect-selector select');
  const bundleKey = await accepted.locator('option').filter({hasText:'Bundle 2'}).getAttribute('value');
  await accepted.selectOption(bundleKey);
  const observed = inspector.locator('.observed-sample');
  // The old bundle also contains this trigger. Wait for its other rows to leave.
  await observed.nth(1).waitFor({state:'detached'});
  await observed.locator('[data-sample-id$="/trigger_left/value/active"] .sample-value').filter({hasText:'true'}).waitFor();
  assert.equal(await observed.count(), 1);
  assert.ok(Math.abs(Number(await observed.locator('[data-sample-id$="/trigger_left/value"] .sample-value').innerText()) - 0.25) < 0.01);
  const rawKey = await accepted.locator('option').filter({hasText:'Bundle 1'}).getAttribute('value');
  await accepted.selectOption(rawKey);
  const buttonDisplay = await verifyControllerButton(page, picker);
  if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT,fullPage:true});
  console.log('PASS gamepad current-viewer integration',JSON.stringify({normal,protocol,buttonReadings:[baseline,down,up],buttonDisplay,ui:'populated sticks/triggers, reliable replacement with on-change bundle'},(_,v)=>typeof v==='bigint'?v.toString():v));

  }
} finally {
  if(browser)await browser.close();
  for(const p of children.reverse()){
    if(p.exitCode!==null)continue;
    const exited=once(p,'exit');p.kill('SIGINT');
    const timer=setTimeout(()=>p.kill('SIGKILL'),5000);
    await exited;clearTimeout(timer);
  }
}


async function verifyControllerButton(page, picker) {
  const counters = async (minPresses, minReleases) => {
    const reading = await page.waitForFunction(([minPresses, minReleases]) => {
      const read = kind => Number.parseInt(document.querySelector(
        '#sample-inspector [data-sample-id="/user/gamepad/input/a/click/' + kind + '_count"] .sample-value'
      )?.textContent, 10);
      const presses = read('press'), releases = read('release');
      if (presses >= minPresses && releases >= minReleases) return {presses, releases};
    }, [minPresses, minReleases]);
    return reading.jsonValue();
  };
  const before = await counters(0, 0);
  await picker.selectOption('auto');
  await page.locator('.gamepad [data-control="a/click"]').scrollIntoViewIfNeeded();
  const states = [];
  for (const held of [false, true, false]) {
    const reading = await page.waitForFunction(held => {
      const cell = document.querySelector('.gamepad [data-control="a/click"]');
      if (!cell || cell.hasAttribute('data-held') !== held) return;
      const label = cell.querySelector('span').textContent;
      if (!/^(Pressed|Released)/.test(label)) return;
      const {x, y, width, height} = cell.getBoundingClientRect();
      if (x < 0 || y < 0 || x + width > innerWidth || y + height > innerHeight) return;
      const style = getComputedStyle(cell);
      return {label, bounds: [x, y, width, height], background: style.backgroundColor, outline: style.outlineStyle};
    }, held);
    const state = await reading.jsonValue();
    assert.equal(state.label, held ? 'Pressed' : 'Released');
    assert.equal(state.outline, 'none');
    states.push(state);
  }
  const [released, pressed, releasedAgain] = states;
  assert.ok(released.bounds[2] > 0 && released.bounds[3] > 0);
  assert.deepEqual(pressed.bounds, released.bounds);
  assert.deepEqual(releasedAgain.bounds, released.bounds);
  assert.notEqual(pressed.background, released.background);
  assert.equal(releasedAgain.background, released.background);
  await picker.selectOption('values');
  const after = await counters(before.presses + 1, before.releases + 1);
  await picker.selectOption('auto');
  return {states, before, after};
}

async function verifyVirtual(page) {
  const report=await page.evaluate(async()=>{
    const {Connection}=await import('/src/connection.ts');
    const {currentValues,spatialFrames}=await import('/src/tracking-view.ts');
    const c=new Connection(()=>{}),reports={};let segment,resetSeen=false,samples=0,retainedRaw=false;
    const requirements=['forward','back','right','left','up','down','yawRight','yawLeft','pitchUp','pitchDown','rollRight','rollLeft','neutral','paused','combined'];
    const delta={forward:[2,-1],back:[2,1],right:[0,1],left:[0,-1],up:[1,1],down:[1,-1],yawRight:[4,-1],yawLeft:[4,1],pitchUp:[3,1],pitchDown:[3,-1],rollRight:[5,-1],rollLeft:[5,1]};
    try {
      await c.connect();const deadline=performance.now()+22000;
      while(performance.now()<deadline) {
        if(c.state.status==='Error')throw Error(c.state.detail);
        const caps=c.session.capabilities;
        if(caps) {
          const values=currentValues(c.session,performance.now());
          const get=id=>values.get(caps.descriptors.findIndex(d=>d.id===id));
          const pose=get('/gamepad/virtual/pose');
          if(pose?.packet) {
            const bundles=pose.subscription.request.bundles;
            const continuous=caps.descriptors.filter(d=>d.id.startsWith('/gamepad/virtual/')).map(d=>d.id);
            if(bundles.length!==2 || bundles[0].length!==continuous.length ||
              bundles[0].some(b=>!continuous.includes(caps.descriptors[b.descriptor].id)) ||
              bundles[1].length!==caps.descriptors.length-continuous.length)throw Error('Wrong mixed default subscription');
            samples++;if(pose.stale)throw Error('Virtual pose stale while idle/paused');
            const desc=caps.descriptors.find(d=>d.id==='/gamepad/virtual/pose');
            if(desc.kind!==10||desc.spaces.length!==1||desc.spaces[0]!==6)throw Error('Virtual pose is not model-space kind10');
            if(pose.packet.predictedFor!==null)throw Error('Virtual pose fabricated prediction');
            const p=pose.value;
            if(p.length!==7||p.some(v=>!Number.isFinite(v))||Math.abs(p.slice(3).reduce((s,x)=>s+x*x,0)-1)>1e-5)throw Error('Invalid quaternion/position');
            for(const [suffix,expected] of [['position_valid',true],['orientation_valid',true],['position_tracked',false],['orientation_tracked',false]]) {
              const quality=get('/gamepad/virtual/pose/'+suffix);
              if(quality?.value!==expected||quality.packet.timestamp!==pose.packet.timestamp)throw Error('Untruthful virtual quality '+suffix);
            }
            const spatial=spatialFrames(c.session,performance.now());
            if(spatial.space!==6||spatial.sources[0]!=='/gamepad/virtual/pose'||spatial.poses.poses[0]?.flags!==3)throw Error('Generic viewer failed to interpret virtual pose');
            const raw=suffix=>{
              const v=get('/user/gamepad/input/'+suffix),active=get('/user/gamepad/input/'+suffix+'/active');
              if(!v?.packet || v.stale || v.packet.timestamp>pose.packet.timestamp ||
                active?.value!==true || active.packet.timestamp!==v.packet.timestamp)throw Error('Invalid retained raw input '+suffix);
              if(!pose.packet.bundles[1] && v.packet.timestamp<pose.packet.timestamp)retainedRaw=true;
              return v.value;
            };
            const l=raw('thumbstick_left'),r=raw('thumbstick_right'),lt=raw('trigger_left/value'),rt=raw('trigger_right/value'),lb=raw('shoulder_left/click'),rb=raw('shoulder_right/click');
            const motion=get('/gamepad/virtual/enabled');
            if(motion.packet.timestamp!==pose.packet.timestamp)throw Error('Virtual motion state did not accompany pose');
            const enabled=motion.value;
            const reset=raw('view/click');
            let label;
            const moving=l.some(x=>x!==0)||r.some(x=>x!==0)||lt!==0||rt!==0||lb||rb;
            if(reset) {
              if(enabled||p.some((x,i)=>x!==(i===6?1:0)))throw Error('Reset failed to pause and restore origin');
              resetSeen=true;label='reset';
            } else if(!enabled&&moving)label='paused';
            else if(!enabled)label='disabled';
            else if(l[0]>0&&l[1]>0&&r[0]>0)label='combined';
            else if(l[1]===1)label='forward';else if(l[1]===-1)label='back';
            else if(l[0]===1)label='right';else if(l[0]===-1)label='left';
            else if(rt===1)label='up';else if(lt===1)label='down';
            else if(r[0]===1)label='yawRight';else if(r[0]===-1)label='yawLeft';
            else if(r[1]===1)label='pitchUp';else if(r[1]===-1)label='pitchDown';
            else if(rb)label='rollRight';else if(lb)label='rollLeft';else label='neutral';
            const at=Number(pose.packet.timestamp)/1e9;
            if(!segment||segment.label!==label)segment={label,p:[...p],at};
            if(at-segment.at>0.2&&!reports[label]&&requirements.includes(label)) {
              if(delta[label]){const [axis,sign]=delta[label];if((p[axis]-segment.p[axis])*sign<0.03)throw Error('Wrong axis/direction '+label);}
              else if(label==='neutral'||label==='paused'){if(p.some((x,i)=>Math.abs(x-segment.p[i])>1e-5))throw Error('Motion while '+label);}
              else if(label==='combined'){if(Math.hypot(...p.slice(0,3).map((x,i)=>x-segment.p[i]))<0.05||Math.hypot(...p.slice(3).map((x,i)=>x-segment.p[i+3]))<0.05)throw Error('Combined motion did not translate and rotate');}
              reports[label]={seconds:at-segment.at,delta:p.map((x,i)=>x-segment.p[i])};
            }
            if(resetSeen&&requirements.every(key=>reports[key]))break;
          }
        }
        await new Promise(r=>setTimeout(r,15));
      }
      if(!resetSeen||!requirements.every(key=>reports[key]))throw Error('Missing virtual coverage '+requirements.filter(key=>!reports[key]).join(','));
      if(!retainedRaw)throw Error('Continuous pose never advanced independently of acknowledged inputs');
      return {samples,reports,reset:true,modelSpace:true,tracked:false,predictedFor:null,retainedRaw};
    }finally{c.close();}
  });
  await page.getByRole('dialog').getByRole('button',{name:'Connect',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Connected');
  await page.getByRole('combobox', {name:'Visualization', exact:true}).selectOption('spatial');
  await page.waitForFunction(()=>document.querySelector('[data-pose-count="1"]'));
  await page.waitForFunction(()=>{
    const row=document.querySelector('tr[data-descriptor="/gamepad/virtual/pose"]');
    if(!row)return false;row.scrollIntoView({block:'center'});return true;
  });
  await page.waitForFunction(()=>document.querySelector('tr[data-descriptor="/gamepad/virtual/pose"]')?.dataset.available==='true');
  assert.equal(await page.locator('[data-bundle-index="0"] tr[data-descriptor="/gamepad/virtual/pose"]').count(),1);
  assert.equal(await page.locator('[data-bundle-index="1"] tr[data-descriptor="/user/gamepad/input/a/click"]').count(),1);
  if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT,fullPage:true});
  console.log('PASS virtual gamepad current-viewer integration',JSON.stringify({...report,uiRenderedPoseCount:1}));
}
