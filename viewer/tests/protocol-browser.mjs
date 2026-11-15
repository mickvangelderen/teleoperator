import assert from "node:assert/strict";

export async function checkProtocol(page) {
  const results = await page.evaluate(async () => {
    const { Session } = await import("/src/session.ts");
    const { periodic, decodeTracking } = await import("/src/protocol.ts");
    const session = new Session(), pc = new RTCPeerConnection({iceServers: []});
    const reliable = pc.createDataChannel("reliable", {ordered:true,protocol:"xrop"});
    const unreliable = pc.createDataChannel("unreliable", {ordered:false,maxRetransmits:0,protocol:"xrop"});
    const errors = [], capabilityMessages = [], wirePublications = new Map();
    const wait = async (condition, label) => {
      const end = performance.now()+10000;
      while (!condition()) {
        if (errors.length) throw new Error(errors.join("; "));
        if (performance.now()>end) throw new Error(`Timed out: ${label}; ${session.detail}`);
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    };
    for (const dc of [reliable,unreliable]) {
      dc.binaryType="arraybuffer";
      dc.onmessage=event=>{try {
        const bytes=new Uint8Array(event.data);
        if(dc===reliable){
          if(bytes[0]===3)capabilityMessages.push(bytes.length);
          session.control(bytes,performance.now());
        }else {
          if (bytes[0] === 9 && bytes.length >= 21) {
            const id = new DataView(bytes.buffer).getUint32(1,true), previous = wirePublications.get(id);
            wirePublications.set(id,{count:(previous?.count ?? 0)+1,body:bytes.slice(1)});
          }
          session.unreliable(bytes,performance.now());
        }
      }catch(e){errors.push(String(e));}};
    }
    const send=bytes=>reliable.send(bytes);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await wait(()=>pc.iceGatheringState==="complete","ICE gathering");
      const response=await fetch("/api/offer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pc.localDescription)});
      if(!response.ok)throw new Error(`Signaling ${response.status}`);
      await pc.setRemoteDescription(await response.json());
      await wait(()=>reliable.readyState==="open"&&unreliable.readyState==="open","channels");
      send(session.start()); await wait(()=>session.phase==="ready","discovery");
      const c=session.capabilities;
      const rest=c.skeletons[0].joints[1].rest_pose_sample, group=c.descriptors[rest].group;
      const samples=[{descriptor:rest,format:10,space:c.descriptors[rest].spaces[0]}];
      const counts=[];
      for(const delivery of [1,2])for(const kind of ["periodic","onChange"]){
        const id=session.allocateId();
        const request={id,group,delivery,schedule:kind==="periodic"?periodic(50,7_000_000n,25_000_000n):{kind},samples};
        send(session.request(request));
        await wait(()=>session.active.has(id)&&(delivery===1?wirePublications.get(id)?.count>0:session.active.get(id).packets>0),"initial snapshot");
        await new Promise(resolve=>setTimeout(resolve,130));
        const sub=session.active.get(id), wire=wirePublications.get(id);
        const packet=delivery===1?decodeTracking(wire.body,c,request):sub.packet;
        counts.push({delivery,kind,packets:delivery===1?wire.count:sub.packets,prediction:packet.predictedFor,acquisition:String(packet.timestamp)});
        if(kind==="onChange"){
          const before=sub.packets;
          send(session.changeSchedule(id,periodic(50,9_000_000n,25_000_000n)));
          await wait(()=>sub.packets>=before+3,"live periodic schedule update");
          send(session.changeSchedule(id,{kind:"onChange"}));
          await new Promise(resolve=>setTimeout(resolve,60));
          const settled=sub.packets;
          await new Promise(resolve=>setTimeout(resolve,80));
          if(sub.packets!==settled)throw new Error("OnChange update forced a refresh");
          if(sub.request.samples[0].descriptor!==rest)throw new Error("Schedule update changed selection");
        }
        send(session.stop(id));await wait(()=>!session.stopping.has(id),"unsubscribe");
      }
      const head=c.descriptors.findIndex(d=>d.id==="/user/head/input/pose"), id=session.allocateId();
      const request={id,group:c.descriptors[head].group,delivery:1,schedule:periodic(50, 7_000_000n, 35_000_000n),samples:[{descriptor:head,format:10,space:c.descriptors[head].spaces[0]}]};
      send(session.request(request));await wait(()=>session.active.get(id)?.packets>0,"predicted pose");
      const targets = [];
      for (const schedule of [request.schedule, periodic(50, 11_000_000n, 65_000_000n)]) {
        send(session.changeSchedule(id, schedule));
        const sub = session.active.get(id), before = sub.packets;
        await wait(() => sub.packets >= before + 3, "updated prediction target");
        targets.push({ grid: String((sub.packet.predictedFor - schedule.consumptionDelay - schedule.phase) % schedule.interval), delay: String(schedule.consumptionDelay) });
      }
      // Acquiring before P can make a zero-delay target future. Such publications
      // are allowed; predicting into the past is not. Expiry at submission is
      // checked with a deterministic server clock in the Rust tests.
      send(session.changeSchedule(id, periodic(50, 3_000_000n, 0n)));
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        const packet = session.active.get(id).packet;
        if (packet && packet.predictedFor <= packet.timestamp) throw new Error("Prediction did not follow acquisition");
      }
      // Fresh subscriptions must bootstrap their preparation estimate even when
      // the initial zero/small-delay attempts expire before they can be sent.
      for (const delay of [0n, 300_000n]) {
        const coldId = session.allocateId();
        send(session.request({...request, id: coldId, schedule: periodic(50, 3_000_000n, delay)}));
        await wait(() => session.active.get(coldId)?.packets >= 3, `cold delay ${delay} publishes`);
        const packet = session.active.get(coldId).packet;
        if (packet.predictedFor <= packet.timestamp) throw new Error("Cold prediction did not follow acquisition");
        send(session.stop(coldId));
        await wait(() => !session.stopping.has(coldId), "cold unsubscribe");
      }
      const invalid=session.request({...request,schedule:periodic(50)});invalid.fill(0,invalid.length-24,invalid.length-16);
      send(invalid);await wait(()=>!session.pending.has(id),"rejected replacement");
      if(!session.active.has(id)||!session.detail.includes("rejected"))throw new Error("Rejected replacement retired old state");
      // Same-id reliable replacement has ordered termination, acceptance and data.
      send(session.request({...request,delivery:2}));await wait(()=>session.active.get(id)?.request.delivery===2&&session.active.get(id)?.packets>0,"same-id replacement");
      const probe=session.requestClock(performance.now());unreliable.send(probe);
      await wait(()=>!!session.clock,"clock response");
      send(session.stop(id));await wait(()=>!session.stopping.has(id),"final unsubscribe");
      return {counts,targets,clock:!!session.clock,capabilityMessages,errors};
    }finally{pc.close();session.retire();}
  });
  for(const item of results.counts){
    assert.equal(item.prediction,null,"Rest samples do not claim prediction");
    if(item.kind==="onChange")assert.equal(item.packets,1);
    else assert.ok(item.packets>=3,JSON.stringify(item));
  }
  assert.equal(new Set(results.counts.map(item => item.acquisition)).size, 1, "Repeated rest publications retain the skeleton acquisition timestamp");
  assert.ok(BigInt(results.counts[0].acquisition) > 0n, "Synthetic rest records its acquisition after server startup");
  assert.equal(results.capabilityMessages.length,1,"Full capabilities arrive as one WebRTC message");
  assert.ok(results.capabilityMessages[0]>16_384 && results.capabilityMessages[0]<=1_048_576);
  console.log(`Full catalog WebRTC message: ${results.capabilityMessages[0]} bytes`);
  for (const target of results.targets) assert.equal(target.grid, "0", `Actual synthetic target follows requested phase + delay ${target.delay}`);
  assert.equal(results.clock,true);
  assert.deepEqual(results.errors,[]);
}
