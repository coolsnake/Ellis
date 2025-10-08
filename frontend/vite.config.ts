import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Forward API calls to the backend during dev to avoid CORS and adblockers
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // Enable WebSocket proxying for Socket.IO
      '/socket.io': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
    }
  },
  define: {
    'import.meta.env.VITE_USE_CONTEXT_SOCKET': JSON.stringify('true'),
    // Default to same-origin paths; override via env when needed
    'import.meta.env.VITE_API_BASE': JSON.stringify(((globalThis as any).process?.env?.VITE_API_BASE) || '/api'),
    'import.meta.env.VITE_WS_URL': JSON.stringify(((globalThis as any).process?.env?.VITE_WS_URL) || '/'),
  }
})


