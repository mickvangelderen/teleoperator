import assert from "node:assert/strict";

export async function checkProtocol(page) {
  const results = await page.evaluate(async () => {
    const { Session } = await import("/src/session.ts");
    const { timing, decodeTracking } = await import("/src/protocol.ts");
    const session = new Session(), pc = new RTCPeerConnection({iceServers: []});
    const reliable = pc.createDataChannel("reliable", {ordered:true,protocol:"xrop"});
    const unreliable = pc.createDataChannel("unreliable", {ordered:false,maxRetransmits:0,protocol:"xrop"});
    const errors = [], capabilityMessages = [], wirePublications = new Map(), acks = [];
    let dropAcks = false;
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
        if(bytes[0]===3)capabilityMessages.push(bytes.length);
        if(bytes[0]===9 && bytes.length>=21){
          const id=new DataView(bytes.buffer).getUint32(1,true), request=session.active.get(id)?.request;
          if(request){const entries=wirePublications.get(id)??[];entries.push({bytes,packet:decodeTracking(bytes.subarray(1),session.capabilities,request)});wirePublications.set(id,entries);}
        }
        if(dc===reliable)session.control(bytes,performance.now());else session.unreliable(bytes,performance.now());
        for(const ack of session.takeAcknowledgments()){
          acks.push({bytes:Array.from(ack),dropped:dropAcks});
          if(!dropAcks)unreliable.send(ack);
        }
      }catch(e){errors.push(String(e));}};
    }
    const send=bytes=>reliable.send(bytes);
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await wait(()=>pc.iceGatheringState==="complete","ICE gathering");
      const response=await fetch("/api/offer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pc.localDescription)});
      if(!response.ok)throw new Error(`Signaling ${response.status}`);
      await pc.setRemoteDescription(await response.json());
      await wait(()=>reliable.readyState==="open"&&unreliable.readyState==="open","channels");
      send(session.start());await wait(()=>session.phase==="ready","discovery");
      const c=session.capabilities, rest=c.skeletons[0].joints[1].rest_pose_sample, group=c.descriptors[rest].group;
      const binding={descriptor:rest,format:10,space:c.descriptors[rest].spaces[0]}, counts=[];
      for(const delivery of [1,2])for(const changed of [false,true]){
        const id=session.allocateId(),request={id,group,delivery,...timing(50,7_000_000n,25_000_000n),sequenceNumberFormat:changed?2:null,bundles:changed?[[],[binding]]:[[binding]]};
        dropAcks=changed;
        send(session.request(request));await wait(()=>session.active.get(id)?.packets>=3,"scheduled snapshots / lost ACK repeats");
        const sub=session.active.get(id), entries=wirePublications.get(id);
        if(changed){
          if(new Set(entries.map(e=>String(e.packet.sequenceNumber))).size!==entries.length)throw new Error("Repeated pending state reused a sequence");
          dropAcks=false;await pause(80);
          const settled=sub.packets;await pause(100);
          if(sub.packets!==settled)throw new Error("Exact ACK did not stop unchanged bundle");
          const retained=sub.bundles[1];send(session.changeSchedule(id,timing(100,9_000_000n,65_000_000n)));
          await pause(100);
          if(sub.packets!==settled||sub.bundles[1]!==retained)throw new Error("Timing update reset acknowledged state");
        }
        counts.push({delivery,changed,packets:sub.packets,prediction:sub.packet.predictedFor,acquisition:String(sub.packet.timestamp)});
        send(session.stop(id));await wait(()=>!session.stopping.has(id),"unsubscribe");
      }
      // Continuous bundle 0 keeps publishing while ACKed bundle 1 is omitted.
      const mixedId=session.allocateId(), mixed={id:mixedId,group,delivery:1,...timing(50),sequenceNumberFormat:1,bundles:[[binding],[binding]]};
      send(session.request(mixed));await wait(()=>session.active.get(mixedId)?.packets>=5,"sparse rest stream");
      const mixedSub=session.active.get(mixedId), all=wirePublications.get(mixedId), retained=mixedSub.bundles[1];
      if(!all.some(e=>e.packet.bundles[1]===null)||!retained)throw new Error("Acknowledged bundle was not omitted");
      const old=all.find(e=>e.packet.bundles[1]!==null);
      session.unreliable(old.bytes,performance.now());
      const duplicateAck=session.takeAcknowledgments();
      if(duplicateAck.length!==1||mixedSub.bundles[1]!==retained)throw new Error("Delayed actual packet changed retained state or lost ACK");
      unreliable.send(duplicateAck[0]);
      send(session.stop(mixedId));await wait(()=>!session.stopping.has(mixedId),"mixed unsubscribe");
      const head=c.descriptors.findIndex(d=>d.id==="/user/head/input/pose"),id=session.allocateId();
      const request={id,group:c.descriptors[head].group,delivery:1,...timing(50,7_000_000n,35_000_000n),sequenceNumberFormat:null,bundles:[[{descriptor:head,format:10,space:c.descriptors[head].spaces[0]}]]};
      send(session.request(request));await wait(()=>session.active.get(id)?.packets>=3,"live pose");
      const sub=session.active.get(id), before=sub.packets;
      send(session.changeSchedule(id,timing(100,11_000_000n,65_000_000n)));
      await wait(()=>sub.packets>=before+5,"live timing update");
      if(session.active.get(id)!==sub)throw new Error("Timing update replaced subscription");
      const invalid=session.request(request);new DataView(invalid.buffer).setUint32(5,99,true);
      send(invalid);await wait(()=>!session.pending.has(id),"rejected replacement");
      if(session.active.get(id)!==sub||!session.detail.includes("rejected"))throw new Error("Rejection retired old state");
      // Acceptance is itself the same-id boundary, with no invented ending response.
      send(session.request({...request,delivery:2}));await wait(()=>session.active.get(id)?.request.delivery===2&&session.active.get(id)?.packets>0,"same-id replacement");
      for(let i=0;i<5;i++){unreliable.send(session.requestClock(performance.now()));await pause(250);}
      await wait(()=>!!session.clockEstimate(performance.now()),"clock alignment");
      send(session.stop(id));await wait(()=>!session.stopping.has(id),"final unsubscribe");
      return {counts,clock:!!session.clockEstimate(performance.now()),capabilityMessages,acks,errors};
    }finally{pc.close();session.retire();}
  });
  for(const item of results.counts){assert.equal(item.prediction,null,"Rest geometry has no actual target");assert.ok(item.packets>=3);}
  assert.equal(new Set(results.counts.map(item=>item.acquisition)).size,1,"Cached rest acquisitions retain their timestamp");
  assert.equal(results.capabilityMessages.length,1);assert.ok(results.capabilityMessages[0]>16384);
  assert.ok(results.acks.some(a=>a.dropped));assert.ok(results.acks.some(a=>!a.dropped));
  assert.equal(results.clock,true);assert.deepEqual(results.errors,[]);
  console.log(`PASS: WebRTC timed/changed bundles on both channels, lost ACK repair, sparse retention, delayed duplicates, live timing, rejection and same-id replacement (${results.capabilityMessages[0]} capability bytes)`);
}
