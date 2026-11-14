import assert from "node:assert/strict";

export async function checkProtocol(page) {
  const results = await page.evaluate(async () => {
    const { Session } = await import("/src/session.ts");
    const { periodic, decodeTracking } = await import("/src/protocol.ts");
    const session = new Session(), pc = new RTCPeerConnection({iceServers: []});
    const reliable = pc.createDataChannel("reliable", {ordered:true,protocol:"xrop"});
    const unreliable = pc.createDataChannel("unreliable", {ordered:false,maxRetransmits:0,protocol:"xrop"});
    const errors = [], wirePublications = new Map();
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
        if(dc===reliable)session.control(bytes,performance.now());else {
          if (bytes[0] === 9 && bytes.length >= 21) {
            const id = new DataView(bytes.buffer).getUint32(1,true), previous = wirePublications.get(id);
            wirePublications.set(id,{count:(previous?.count ?? 0)+1,body:bytes.slice(1)});
          }
          session.unreliable(bytes,performance.now());
        }
      }catch(e){errors.push(String(e));}};
    }
    // Split reliable records deliberately, including inside pose selections and schedule fields.
    const send=bytes=>{for(let i=0;i<bytes.length;i+=3)reliable.send(bytes.subarray(i,i+3));};
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
        const request={id,group,delivery,schedule:kind==="periodic"?periodic(50,7_000_000n):{kind},samples};
        send(session.request(request));
        await wait(()=>session.active.has(id)&&(delivery===1?wirePublications.get(id)?.count>0:session.active.get(id).packets>0),"initial snapshot");
        await new Promise(resolve=>setTimeout(resolve,130));
        const sub=session.active.get(id), wire=wirePublications.get(id);
        const packet=delivery===1?decodeTracking(wire.body,c,request):sub.packet;
        counts.push({delivery,kind,packets:delivery===1?wire.count:sub.packets,prediction:packet.predictedFor});
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
      const request={id,group:c.descriptors[head].group,delivery:1,schedule:periodic(50),samples:[{descriptor:head,format:10,space:c.descriptors[head].spaces[0]}]};
      send(session.request(request));await wait(()=>session.active.get(id)?.packets>0,"predicted pose");
      const prediction=String(session.active.get(id).packet.predictedFor-session.active.get(id).packet.timestamp);
      const invalid=session.request({...request,schedule:periodic(50)});invalid.fill(0,invalid.length-24,invalid.length-16);
      send(invalid);await wait(()=>!session.pending.has(id),"rejected replacement");
      if(!session.active.has(id)||!session.detail.includes("rejected"))throw new Error("Rejected replacement retired old state");
      // Same-id reliable replacement has ordered termination, acceptance and data.
      send(session.request({...request,delivery:2}));await wait(()=>session.active.get(id)?.request.delivery===2&&session.active.get(id)?.packets>0,"same-id replacement");
      const probe=session.requestClock(performance.now());unreliable.send(probe);
      await wait(()=>!!session.clock,"clock response");
      send(session.stop(id));await wait(()=>!session.stopping.has(id),"final unsubscribe");
      return {counts,prediction,clock:!!session.clock,errors};
    }finally{pc.close();session.retire();}
  });
  for(const item of results.counts){
    assert.equal(item.prediction,null,"Rest samples do not claim prediction");
    if(item.kind==="onChange")assert.equal(item.packets,1);
    else assert.ok(item.packets>=3,JSON.stringify(item));
  }
  assert.equal(results.prediction,"25000000","Wire time reflects the actual synthetic target");
  assert.equal(results.clock,true);
  assert.deepEqual(results.errors,[]);
}
