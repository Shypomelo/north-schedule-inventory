// Local test-only loader; never included by the application.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
module.exports=function load(filename,mocks={}) {
 const m=new Module(filename,module);m.filename=filename;m.paths=module.paths;
 m.require=id=>{if(id in mocks)return mocks[id];if(id.startsWith('.')||id.startsWith('@/')){
  const base=id.startsWith('@/')?path.resolve(__dirname,'..',id.slice(2)):path.resolve(path.dirname(filename),id);
  const resolved=['', '.ts','.tsx'].map(ext=>base+ext).find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
  if(resolved)return load(resolved,mocks);
 }return require(id);};
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);return m.exports;
};
