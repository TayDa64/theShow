import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // In normal local dev, ignore generated/runtime files that should not cause
      // full-page reload storms (for example account/project JSON persistence).
      watch: process.env.DISABLE_HMR === 'true'
        ? null
        : {
            ignored: [
              '**/.git/**',
              '**/node_modules/**',
              '**/coverage/**',
              '**/dist/**',
              '**/uploads/**',
              '**/.storyforge/**',
              '**/playwright-report/**',
              '**/test-results/**',
              '**/README.md',
              '**/status_liku.md',
              '**/docs/**',
              '**/playwright/**',
            ],
          },
    },
    test: {
      environment: 'node',
      globals: true,
      setupFiles: './tests/setup.ts',
      exclude: ['playwright/**', 'e2e/**', 'node_modules/**', 'dist/**'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
      },
    },
  };
});
