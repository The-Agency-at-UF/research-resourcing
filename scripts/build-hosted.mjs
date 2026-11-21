import { build } from 'esbuild';

// Bundle the two Slack Lambdas as ESM into a folder tsc never writes (it emits src/hosted to dist/hosted, which Lambda would load first). The banner restores `require` for CommonJS dependencies inside the bundle.
await build({
  entryPoints: ['src/hosted/receiver.ts', 'src/hosted/worker.ts'], outdir: 'dist/slack-lambda', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true, keepNames: true, legalComments: 'none',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
