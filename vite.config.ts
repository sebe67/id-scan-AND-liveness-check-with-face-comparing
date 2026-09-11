import path from "node:path";
import { defineConfig } from "vite";

// Root is example/ (so example/index.html is the dev-server entry), but main.ts imports
// from ../src, so the parent directory needs to be explicitly allowed for Vite's dev
// server to serve those files.
export default defineConfig({
  root: path.resolve(__dirname, "example"),
  server: {
    fs: {
      allow: [path.resolve(__dirname)],
    },
    // getUserMedia requires a secure context - localhost is exempt, but if you ever
    // need to test from another device on your network, this needs HTTPS (a self-signed
    // cert via @vitejs/plugin-basic-ssl, or similar).
  },
});
