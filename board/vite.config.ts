import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // During `npm run dev` (vite) the API comes from wrangler dev on :8787
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
