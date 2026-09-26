import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Copy the one asset from public/ that the panel actually needs.
 *
 * `index.css` asks for `../fonts/Caveat/…` for the handwritten canvas
 * annotations. Without it the notes on every worked example fall back to
 * a system face, which is not a crash and is exactly why it would ship:
 * nothing fails, the examples just stop looking like themselves.
 */
function caveatFont(): Plugin {
  return {
    name: 'breakscale-webview-font',
    apply: 'build',
    closeBundle() {
      cpSync(
        resolve(import.meta.dirname, 'public/fonts'),
        resolve(import.meta.dirname, 'extension/media/fonts'),
        { recursive: true },
      );
    },
  };
}

/**
 * The build the VS Code extension embeds.
 *
 * Separate from vite.config.ts rather than a flag inside it, because almost
 * everything that config does is for a web page that search engines read: a
 * canonical URL, a sitemap, a static glossary route, an origin rewritten per
 * deployment. None of it means anything inside an editor panel, and a webview
 * that shipped a sitemap would be carrying dead weight in a bundle the user
 * downloads once and keeps.
 *
 * Two differences from the web build matter, and both come from where the
 * files end up:
 *
 *   - `base: './'`. A webview serves from a `vscode-webview://` origin whose
 *     host is a generated UUID, so an absolute `/assets/index.js` resolves
 *     against a root that does not exist. Relative paths are the only ones
 *     the extension can rewrite into webview URIs.
 *   - No code splitting. The web build separates React so a returning visitor
 *     re-fetches only what changed, which is the right trade over a network.
 *     Here every byte is already on disk and the panel is opened cold each
 *     time, so a second request buys nothing and costs a round trip through
 *     the webview's asset protocol.
 */
export default defineConfig({
  plugins: [react(), caveatFont()],
  base: './',
  // Nothing from public/ wholesale: a sitemap, robots.txt and an og image
  // are all for a web page. The one thing the panel does need is copied by
  // the plugin above.
  publicDir: false,
  build: {
    outDir: 'extension/media',
    emptyOutDir: true,
    // The panel opens from local disk, so the cost that matters is parse and
    // execute rather than transfer. Minified, no sourcemap: a sourcemap would
    // roughly double what ships in the .vsix for something only this repo's
    // own contributors can act on.
    sourcemap: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'index.webview.html'),
      output: {
        manualChunks: undefined,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
