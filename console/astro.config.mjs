import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 is wired as a Vite plugin (@tailwindcss/vite) — the old @astrojs/tailwind
// integration is retired and doesn't support Astro 6. Theme tokens live in
// src/styles/global.css under @theme (CSS-first config).
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      hmr: false,  /* no persistent HMR WebSocket → tab stops spinning */
    },
  },
});
