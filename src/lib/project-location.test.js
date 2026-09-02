const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'project-location.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = module.paths;
sourceModule._compile(transpiled, sourcePath);

const { parseTaiwanProjectLocation } = sourceModule.exports;

test('parseTaiwanProjectLocation preserves the complete canonical district name', () => {
  const cases = [
    ['桃園市平鎮區中豐路南勢二段460巷118-7號', '桃園市', '平鎮區'],
    ['桃園市蘆竹區聯福街二巷12-2號', '桃園市', '蘆竹區'],
    ['台南市新市區中正路1號', '台南市', '新市區'],
    ['彰化縣田中鎮中州路一段1號', '彰化縣', '田中鎮'],
    ['嘉義縣民雄鄉建國路一段1號', '嘉義縣', '民雄鄉'],
    ['新竹市東區光復路二段1號', '新竹市', '東區'],
  ];

  cases.forEach(([address, city, district]) => {
    assert.deepEqual(parseTaiwanProjectLocation(address), { city, district });
  });
});
