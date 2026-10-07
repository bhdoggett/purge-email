import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1421, strictPort: true, fs: { allow: [".."] } },
  resolve: { alias: { "@core": new URL("../core", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "../core/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
