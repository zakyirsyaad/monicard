import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API_TARGET = 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
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
