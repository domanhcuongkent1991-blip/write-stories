import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const apiPort = process.env.INKOS_STUDIO_PORT ?? "4569";
const webHost = process.env.INKOS_STUDIO_WEB_HOST ?? "127.0.0.1";
const webPort = Number(process.env.INKOS_STUDIO_WEB_PORT ?? "4567");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: {
      "/api/v1/events": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        // SSE needs unbuffered streaming — bypass http-proxy response handling
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          });
        },
      },
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
