import { defineConfig, loadEnv } from "vite";
import { recordingPlugin } from "./tools/recording-server.ts";
import { operatorProxy } from "./tools/operator-proxy.ts";
import { operatorOrigin } from "./src/operator-address.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "XR_");
  const target = operatorOrigin(env.XR_OPERATOR_URL || "http://127.0.0.1:8080");
  return {
    plugins: [operatorProxy(target), recordingPlugin()],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
