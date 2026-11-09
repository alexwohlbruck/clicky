import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const api = `http://127.0.0.1:${process.env.SERVER_PORT ?? 3701}`

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3700),
    strictPort: true,
    allowedHosts: ['.ts.net', 'localhost'],
    proxy: {
      '/ws': { target: api, ws: true },
      '/music': api,
      '/health': api,
      '/api': api,
    },
  },
  build: { target: 'es2022' },
})
