import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../static/app',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/me': 'http://127.0.0.1:5001',
      '/logout': 'http://127.0.0.1:5001',
      '/setup-api': 'http://127.0.0.1:5001',
      '/send_code': 'http://127.0.0.1:5001',
      '/verify_code': 'http://127.0.0.1:5001',
      '/verify_password': 'http://127.0.0.1:5001',
      '/folders': 'http://127.0.0.1:5001',
      '/files': 'http://127.0.0.1:5001',
      '/file': 'http://127.0.0.1:5001',
      '/thumbnail': 'http://127.0.0.1:5001',
      '/upload': 'http://127.0.0.1:5001',
      '/delete_data': 'http://127.0.0.1:5001',
    },
  },
})
