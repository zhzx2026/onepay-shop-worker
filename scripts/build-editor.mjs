import { build } from 'esbuild';
await build({
  entryPoints: { 'admin-editor': 'scripts/admin-editor.js', 'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
  outdir: 'public/vendor/monaco', bundle: true, minify: true, format: 'esm', target: ['es2020'],
  loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]', logLevel: 'info',
});
