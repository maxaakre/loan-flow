import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Local dev against the deployed backend: VITE_API_PROXY=https://xxxx.cloudfront.net pnpm dev
const apiProxy = process.env.VITE_API_PROXY;

export default defineConfig({
  plugins: [react()],
  server: apiProxy ? { proxy: { '/api': { target: apiProxy, changeOrigin: true } } } : {},
  test: { environment: 'jsdom', globals: true },
});
