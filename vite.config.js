import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The izzbah-game static site owns the root index.html (it redirects to
// game-mobile.html). To avoid clobbering it, this React demo uses app.html
// as its entry. Dev: `npm run dev` then open /app.html. Build: outputs to dist/.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: { input: 'app.html' },
  },
})
