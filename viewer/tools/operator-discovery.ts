import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { Browser } from "bonjour-service";
import type { Service } from "bonjour-service";
import multicastDNS from "multicast-dns";
import { operatorOrigin } from "../src/operator-address.ts";
import type { OperatorEndpoint } from "../src/operator-address.ts";

const suffix = "._teleoperator._tcp.local";

export function operatorEndpoints(services: Pick<Service, "fqdn" | "port" | "host" | "addresses" | "referer">[]) {
  const endpoints = new Map<string, OperatorEndpoint>();
  const listeners = new Set<string>();
  for (const service of services) {
    const fqdn = service.fqdn.replace(/\.$/, "");
    if (!fqdn.toLowerCase().endsWith(suffix) || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) continue;
    const name = fqdn.slice(0, -suffix.length);
    if (!name) continue;
    const ips = service.addresses ?? [];
    // Prefer the advertised address on the interface that actually answered our query.
    const usable = ips.filter(ip => isIP(ip) && !ip.includes("%") && !/^fe[89ab]/i.test(ip) && !["::", "0.0.0.0"].includes(ip));
    const host = usable.find(ip => ip === service.referer?.address) ?? usable.find(ip => isIP(ip) === 4) ?? usable[0] ?? service.host;
    if (!host || (!isIP(host) && !/^[\w.-]+$/u.test(host))) continue;
    try {
      const address = operatorOrigin(`http://${isIP(host) === 6 ? `[${host}]` : host}:${service.port}`);
      const listener = `${service.host.toLowerCase().replace(/\.$/, "")}:${service.port}`;
      if (!listeners.has(listener) && !endpoints.has(address)) {
        listeners.add(listener);
        endpoints.set(address, { name, address });
      }
    } catch { /* Ignore incomplete or unusable advertisements. */ }
  }
  return [...endpoints.values()].sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

function browseInterface(options: multicastDNS.Options, changed: () => void) {
  const mdns = multicastDNS(options);
  let failed = false;
  mdns.on("error", () => { failed = true; changed(); });
  const browser = new Browser(mdns, { type: "teleoperator", protocol: "tcp" });
  browser.on("up", changed).on("down", changed).on("srv-update", changed);
  return {
    refresh() { browser.expire(); if (!failed) browser.update(); },
    services() { return failed ? null : browser.services; },
    close() { browser.stop(); mdns.destroy(); },
  };
}

export function browseOperators() {
  const browsers = new Map<string, ReturnType<typeof browseInterface>>();
  type Snapshot = OperatorEndpoint[] | null;
  const listeners = new Set<(endpoints: Snapshot) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let previous = "";
  let queued = false;

  function snapshot(): Snapshot {
    const results = [...browsers.values()].map(browser => browser.services()).filter(services => services !== null);
    return results.length ? operatorEndpoints(results.flat()) : null;
  }
  function changed() {
    if (queued) return;
    queued = true;
    // Bonjour can emit down while it is still removing expired services.
    queueMicrotask(() => {
      queued = false;
      if (!listeners.size) return;
      const endpoints = snapshot(), serialized = JSON.stringify(endpoints);
      if (serialized === previous) return;
      previous = serialized;
      for (const listener of listeners) listener(endpoints);
    });
  }

  function refresh() {
    const active = new Set<string>();
    for (const [name, interfaces] of Object.entries(networkInterfaces())) {
      for (const nic of interfaces ?? []) {
        if (nic.internal) continue;
        const ipv6 = nic.family === "IPv6";
        const iface = ipv6 ? `::%${nic.scopeid || name}` : nic.address;
        if (active.has(iface)) continue;
        active.add(iface);
        const current = browsers.get(iface);
        if (current?.services()) { current.refresh(); continue; }
        current?.close();
        try {
          browsers.set(iface, browseInterface(ipv6
            ? { type: "udp6", ip: "ff02::fb", bind: "::", interface: iface }
            : { type: "udp4", bind: "0.0.0.0", interface: iface }, changed));
        } catch { browsers.delete(iface); }
      }
    }
    for (const [iface, browser] of browsers) {
      if (!active.has(iface)) { browser.close(); browsers.delete(iface); }
    }
    changed();
  }
  function close() {
    clearInterval(timer);
    for (const browser of browsers.values()) browser.close();
    browsers.clear();
    listeners.clear();
    previous = "";
  }
  return {
    snapshot,
    get active() { return listeners.size > 0; },
    subscribe(listener: (endpoints: Snapshot) => void) {
      if (!listeners.size) {
        refresh();
        timer = setInterval(refresh, 30_000);
        previous = JSON.stringify(snapshot());
      }
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
        if (!listeners.size) close();
      };
    },
    close,
  };
}
