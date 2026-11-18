import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorEndpoints } from "../tools/operator-discovery";
import { healthLabel } from "../src/operator-chooser";

test("DNS-SD selects the answering address, deduplicates interfaces and preserves ports and instance names", () => {
  const service = {
    fqdn: "Desk 2.0._teleoperator._tcp.local.", port: 8082, host: "desk.local",
    addresses: ["192.0.2.1", "192.0.2.2"], referer: { address: "192.0.2.2", port: 5353, family: "IPv4" as const, size: 130 },
  };
  assert.deepEqual(operatorEndpoints([
    service, { ...service, addresses: ["192.0.2.1"] },
    { ...service, fqdn: "Second._teleoperator._tcp.local", port: 8000, addresses: ["2001:db8::2"] },
    { ...service, fqdn: "Other._http._tcp.local" }, { ...service, port: 0 },
  ]), [
    { name: "Desk 2.0", address: "http://192.0.2.2:8082" },
    { name: "Second", address: "http://[2001:db8::2]:8000" },
  ]);
  assert.equal(operatorEndpoints([{ ...service, addresses: ["fe80::1"] }])[0].address, "http://desk.local:8082");
});

test("HTTP availability is independent of input and signaling", () => {
  for (const health of [{ tracking: false }, { selected: null }, { selected: { connected: false } }]) {
    assert.equal(healthLabel(health), "HTTP reachable · input unavailable");
  }
  for (const health of [{ unknown: 1 }, { tracking: true }, { held: false }, { selected: { connected: true } }]) {
    assert.equal(healthLabel(health), "HTTP reachable");
  }
});
