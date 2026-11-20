// Run on an isolated viewer page whose signaling proxy points at the test phone.
export async function checkClientLifecycle(page) {
  return page.evaluate(async () => {
    const {offer} = await import('/src/protocol.ts');
    const peers = [];
    const counts = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function wait(predicate, label) {
      const end = performance.now() + 10000;
      while (!(await predicate())) {
        if (performance.now() >= end) throw Error('Timed out waiting for ' + label);
        await sleep(25);
      }
    }
    async function count(expected, label) {
      await wait(async () => {
        const response = await fetch('/api/health', {cache: 'no-store'});
        return response.ok && (await response.json()).active_clients === expected;
      }, label);
      counts.push(expected);
    }
    function addUnreliable(pc) {
      return pc.createDataChannel('unreliable', {ordered: false, maxRetransmits: 0, protocol: 'xrop'});
    }
    async function open(both = true) {
      const pc = new RTCPeerConnection({iceServers: []});
      peers.push(pc);
      const reliable = pc.createDataChannel('reliable', {ordered: true, protocol: 'xrop'});
      const unreliable = both && addUnreliable(pc);
      await pc.setLocalDescription(await pc.createOffer());
      await wait(() => pc.iceGatheringState === 'complete', 'ICE gathering');
      const answer = await fetch('/api/offer', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(pc.localDescription),
      });
      if (!answer.ok) throw Error('Signaling failed: ' + answer.status);
      await pc.setRemoteDescription(await answer.json());
      await wait(() => reliable.readyState === 'open' && (!both || unreliable.readyState === 'open'), 'channels');
      return {pc, reliable, unreliable};
    }
    async function negotiate(peer) {
      const selected = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('No version selection')), 5000);
        peer.reliable.addEventListener('message', () => { clearTimeout(timer); resolve(); }, {once: true});
      });
      peer.reliable.send(offer());
      await selected;
    }
    try {
      await count(0, 'health only');
      const first = await open();
      await count(0, 'channels open without negotiation');
      await negotiate(first);
      await count(1, 'first negotiated client, no subscriptions');

      const second = await open(false);
      await negotiate(second);
      await count(1, 'second client missing unreliable channel');
      addUnreliable(second.pc);
      await count(2, 'both clients established');
      first.pc.close();
      await count(1, 'second client remains');
      second.reliable.close();
      await count(0, 'last control channel closed');

      const returning = await open();
      await negotiate(returning);
      await count(1, 'client reconnected');
      returning.pc.close();
      await count(0, 'reconnected client left');
      return counts;
    } finally {
      for (const pc of peers) pc.close();
    }
  });
}
