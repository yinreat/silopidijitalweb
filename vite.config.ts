import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Customer edition supports both the Windows/Electron package and a Vercel browser build.
export default defineConfig(({ mode }) => ({
  // Electron uses relative assets inside app.asar; Vercel serves from site root.
  base: mode === 'web' || mode === 'demo' ? '/' : './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: { exclude: ['lucide-react'] },
}));
