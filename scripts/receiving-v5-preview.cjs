// Isolated DOM harness: real components + API adapter, in-memory transport. NOT authenticated user acceptance.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const esbuild=require(path.join(process.env.RECEIVING_UI_TOOLS||'C:/Vibecode/.codex-tmp/receiving-ui-tools/node_modules','esbuild'));
const out=path.resolve('.codex-logs/receiving-v5-preview');fs.mkdirSync(out,{recursive:true});
const fixture=path.resolve('scripts/receiving-v5-fixture.js');
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {MaterialReceivingCenter} from './src/components/MaterialReceivingCenter';import {store} from './scripts/receiving-v5-fixture';window.__review={store};createRoot(document.getElementById('root')).render(<MaterialReceivingCenter/>);`;
(async()=>{
  await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:path.join(out,'app.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'fixture-transport',setup(build){build.onResolve({filter:/^(@\/lib\/db|@\/lib\/db\/supabaseClient)$/},()=>({path:fixture}));build.onResolve({filter:/UserContext$/},()=>({path:fixture}));}}]});
  const css=await require('postcss')([require('tailwindcss')('./tailwind.config.ts'),require('autoprefixer')]).process(fs.readFileSync('src/app/globals.css','utf8'),{from:'src/app/globals.css'});fs.writeFileSync(path.join(out,'style.css'),css.css);
  const html='<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V5 fixture DOM verification</title><link rel="stylesheet" href="/style.css"><body><main style="max-width:1000px;margin:auto;padding:12px"><h1 style="font-size:24px;margin-bottom:16px">物料到貨</h1><div id="root"></div></main><script src="/app.js"></script></body></html>';
  if(process.argv.includes('--build-only')){console.log('V5 fixture bundle rebuilt');return;}
  http.createServer((req,res)=>{const file=req.url==='/app.js'?'app.js':req.url==='/style.css'?'style.css':null;res.setHeader('Content-Type',file==='app.js'?'text/javascript':file==='style.css'?'text/css':'text/html; charset=utf-8');res.end(file?fs.readFileSync(path.join(out,file)):html);}).listen(3019,'127.0.0.1',()=>console.log('V5 fixture DOM ONLY http://127.0.0.1:3019'));
})().catch(e=>{console.error(e);process.exit(1);});
