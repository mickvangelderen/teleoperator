import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";
import { recordingPlugin } from "./tools/recording-server.ts";

const target = process.env.XR_OPERATOR_URL || "http://192.168.2.9:8080";
const url = new URL(target);
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== "/"
) {
  throw new Error(
    "XR_OPERATOR_URL must be an HTTP(S) origin, for example http://192.168.2.9:8080",
  );
}
const proxy: Record<string, ProxyOptions> = {
  "/api": {
    target: url.origin,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
    configure: (server) => {
      server.on("proxyReq", (request) => request.removeHeader("origin"));
    },
  },
};
export default defineConfig({
  plugins: [recordingPlugin()],
  define: { __OPERATOR_TARGET__: JSON.stringify(url.host) },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
});
