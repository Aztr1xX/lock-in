import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Preact stands in for React at build time: same code, a much smaller download.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
});
