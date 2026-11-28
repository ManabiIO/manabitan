import esbuild from "/workspace/scratch/da6c4dbd0097/manabitan/node_modules/esbuild/lib/main.js";
import path from 'node:path';
await esbuild.build({
  entryPoints: [path.resolve('dev/lib/ucs2length.js')],
  bundle: true, minify: false, sourcemap: true, target: 'es2020',
  format: 'esm', outfile: path.resolve('ext/lib/ucs2length.js'),
  external: ['fs'], banner: {js: '// @ts-nocheck'},
});
console.log(JSON.stringify({node: process.version, esbuild: esbuild.version}));
