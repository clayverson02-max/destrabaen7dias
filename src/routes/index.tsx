import { createFileRoute } from "@tanstack/react-router";
import html from "../static/destrava.html?raw";

// Serves the ready-made static page byte-for-byte (no React rendering).
export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: () =>
        new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  },
});
