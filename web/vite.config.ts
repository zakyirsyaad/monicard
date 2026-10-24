import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API_TARGET = 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  // Pre-bundle deps first used on lazily visited screens: a mid-session re-optimization serves two React copies.
  optimizeDeps: { include: ['qrcode.react'] },
  server: {
    host: true,
    proxy: {
      '/config': API_TARGET,
      '/account': API_TARGET,
      '/fund': API_TARGET,
      '/relay': API_TARGET,
      '/card': API_TARGET,
      '/agent': API_TARGET,
      '^/admin/': API_TARGET,
      '/ws': { target: API_TARGET, ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
  },
});
