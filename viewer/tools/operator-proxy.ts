import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";
import type { Connect, Plugin } from "vite";
import { browseOperators } from "./operator-discovery.ts";
import { operatorOrigin } from "../src/operator-address.ts";

export function operatorProxy(initialAddress: string): Plugin {
  let discovery: ReturnType<typeof browseOperators> | undefined;
  function startDiscovery() {
    try { discovery = browseOperators(); } catch { /* Direct addresses also work without multicast. */ }
  }
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith("/api/")) return next();
    const reply = (status: number, message: string, type = "text/plain") => {
      res.writeHead(status, { "Content-Type": type }).end(message);
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const scheme = req.socket instanceof TLSSocket ? "https" : "http";
    const site = req.headers["sec-fetch-site"];
    if ((site && !["same-origin", "none"].includes(site)) ||
        (req.headers.origin !== undefined && req.headers.origin !== `${scheme}://${req.headers.host}`)) {
      return reply(403, "Use the viewer on the same origin.");
    }
    if (req.method === "GET" && req.url === "/api/operator-address") {
      return reply(200, JSON.stringify(initialAddress), "application/json");
    }
    if (req.method === "GET" && req.url === "/api/operators") {
      const endpoints = discovery?.list();
      return reply(endpoints ? 200 : 503, JSON.stringify(endpoints ?? []), "application/json");
    }
    const health = req.method === "GET" && req.url === "/api/health";
    const offer = req.method === "POST" && req.url === "/api/offer";
    if (!health && !offer) return reply(404, "Unknown operator route.");
    if (offer && req.headers["content-type"]?.split(";")[0] !== "application/json") {
      return reply(415, "Expected a JSON offer.");
    }
    let origin: string;
    try { origin = operatorOrigin(String(req.headers["x-operator-address"] ?? initialAddress)); }
    catch { return reply(400, "Invalid operator address."); }

    // Only forward protocol traffic. Both browser credentials and response headers belong to their own origin.
    const request = origin.startsWith("https:") ? httpsRequest : httpRequest;
    const upstream = request(origin + (health ? "/health" : "/offer"), {
      method: req.method, headers: offer ? { "Content-Type": "application/json" } : {},
      timeout: 15_000,
    }, response => {
      const status = response.statusCode ?? 502;
      if (health) res.setHeader("X-Operator-Response", "1");
      res.writeHead(status, { "Content-Type": status === 200 ? "application/json" : "text/plain" });
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Operator timed out")));
    upstream.on("error", () => {
      if (!res.destroyed && !res.headersSent) reply(502, "Check the operator address and network.");
    });
    res.on("close", () => upstream.destroy());
    if (offer) req.pipe(upstream);
    else upstream.end();
  };
  return {
    name: "xr-operator-proxy",
    configureServer(server) {
      if (server.httpServer) {
        startDiscovery();
        server.httpServer.once("close", () => discovery?.close());
      }
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      startDiscovery();
      server.httpServer.once("close", () => discovery?.close());
      server.middlewares.use(middleware);
    },
  };
}
