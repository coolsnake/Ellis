import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000
  },
  define: {
    'import.meta.env.VITE_USE_CONTEXT_SOCKET': JSON.stringify('true'),
    // Default API/WS endpoints to backend on port 4000; allow override via real env vars
    'import.meta.env.VITE_API_BASE': JSON.stringify(process.env.VITE_API_BASE || 'http://localhost:4000/api'),
    'import.meta.env.VITE_WS_URL': JSON.stringify(process.env.VITE_WS_URL || 'http://localhost:4000'),
  }
})


