import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const entry = (name: string) => fileURLToPath(new URL(`./src/${name}.tsx`, import.meta.url));

export default defineConfig({
  build: {
    cssCodeSplit: false,
    lib: {
      entry: {
        badge: entry('badge'),
        button: entry('button'),
        'empty-state': entry('empty-state'),
        field: entry('field'),
        index: entry('index'),
        input: entry('input'),
        kicker: entry('kicker'),
        panel: entry('panel'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        assetFileNames: 'styles.css',
        entryFileNames: '[name].js',
      },
    },
  },
  plugins: [react()],
});
