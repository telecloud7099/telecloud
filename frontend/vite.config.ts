import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = process.env.VITE_API_URL || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/me': BACKEND,
      '/logout': BACKEND,
      '/check-phone': BACKEND,
      '/setup-api': BACKEND,
      '/send_code': BACKEND,
      '/verify_code': BACKEND,
      '/verify_password': BACKEND,
      '/delete_data': BACKEND,
      '/folders': BACKEND,
      '/files': BACKEND,
      '/file': BACKEND,
      '/thumbnail': BACKEND,
      '/upload': BACKEND,
    },
  },
})
