import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, 'client'),
  publicDir: path.join(root, 'client', 'public'),
  build: {
    outDir: path.join(root, 'dist', 'client'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    fs: { allow: [root] },
  },
  test: {
    root,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
} as any);
