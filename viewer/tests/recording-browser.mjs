import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function checkRecording(browser, url) {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      window.capturedWire = [];
      const create = RTCPeerConnection.prototype.createDataChannel, close = RTCPeerConnection.prototype.close;
      RTCPeerConnection.prototype.close = function () { this.captureClosed = true; close.call(this); };
      RTCPeerConnection.prototype.createDataChannel = function (label, options) {
        const peer = this, channel = create.call(this, label, options), flag = label === "unreliable" ? 1 : 0;
        const copy = (data, flags) => {
          if (!peer.captureClosed) window.capturedWire.push({ flags, bytes: Array.from(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)) });
        };
        const send = channel.send.bind(channel);
        channel.send = data => { send(data); copy(data, flag | 2); };
        channel.addEventListener("message", event => copy(event.data, flag));
        return channel;
      };
    });
    await page.goto(url);
    await page.getByRole("dialog").getByRole("button", { name: "Connect" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected");
    await page.waitForFunction(() => window.capturedWire.filter(packet => packet.flags === 1 && packet.bytes[0] === 9).length >= 20);
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.waitForFunction(() => document.querySelector("#recording-status").textContent.startsWith("Recording saved"));
    const path = await page.locator("#recording-status").getAttribute("title");
    const bytes = await readFile(new URL(`../../${path}`, import.meta.url));
    const observed = await page.evaluate(() => window.capturedWire), packets = [];
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([88, 82, 79, 80, 82, 69, 67, 1]));
    let at = 8, previous = 0;
    while (at < bytes.length) {
      const size = bytes.readUInt32LE(at), flags = bytes[at + 4], time = bytes.readDoubleLE(at + 5);
      assert.ok(time >= previous); previous = time;
      at += 13; assert.ok(at + size <= bytes.length);
      packets.push({ flags, bytes: Array.from(bytes.subarray(at, at + size)) }); at += size;
    }
    assert.equal(packets.length, observed.length, "One record per message observed before disconnect");
    packets.forEach((packet, index) => assert.deepEqual(packet, observed[index], `Verbatim wire message ${index}`));
    assert.deepEqual(packets.slice(0, 3).map(packet => [packet.flags, packet.bytes[0]]), [[2, 1], [0, 2], [0, 3]]);
    assert.ok(packets.some(packet => packet.flags === 2 && packet.bytes[0] === 4), "Subscription descriptions captured");
    assert.ok(packets.some(packet => packet.flags === 0 && packet.bytes[0] === 9), "Reliable rest samples captured");
    assert.ok(packets.some(packet => packet.flags === 1 && packet.bytes[0] === 9), "Unreliable live samples captured");
    assert.ok(packets.some(packet => packet.flags === 3 && packet.bytes[0] === 13), "Exact unreliable ACKs captured");
    console.log(`PASS: ${packets.length} WebRTC messages saved byte-for-byte in observed order (${bytes.length} bytes): ${path}`);
  } finally { await page.close(); }
}
