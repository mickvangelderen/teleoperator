import { defineConfig, loadEnv } from "vite";
import type { ProxyOptions } from "vite";
import { recordingPlugin } from "./tools/recording-server.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "XR_");
  const target = env.XR_OPERATOR_URL || "http://127.0.0.1:8080";
  const url = new URL(target);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "XR_OPERATOR_URL must be an HTTP(S) origin, for example http://127.0.0.1:8080",
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
  return {
    plugins: [recordingPlugin()],
    define: { __OPERATOR_TARGET__: JSON.stringify(url.host) },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
  };
});
