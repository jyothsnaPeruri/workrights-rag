import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site from /<repo>/, so asset URLs need that
  // prefix there. Unset (root) everywhere else, including the dev server.
  base: process.env.VITE_BASE ?? "/",
  // In development the React dev server proxies /api to the Express server, so
  // the browser only ever sees one origin and there is no CORS to configure.
  server: { proxy: { "/api": "http://localhost:8787" } },
});
