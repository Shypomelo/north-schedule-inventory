const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadTypeScriptModule(filename, aliases = {}) {
  const sourcePath = path.join(__dirname, filename);
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const sourceModule = new Module(sourcePath);
  sourceModule.filename = sourcePath;
  sourceModule.paths = module.paths;
  const originalRequire = sourceModule.require.bind(sourceModule);
  sourceModule.require = request => aliases[request] || originalRequire(request);
  sourceModule._compile(transpiled, sourcePath);
  return sourceModule.exports;
}

const projectLocation = loadTypeScriptModule('project-location.ts');
const { selectCwaDaytimeWeather } = loadTypeScriptModule('weather.ts', {
  '@/lib/project-location': projectLocation,
});

function weatherPeriod(startTime, endTime, description) {
  return {
    StartTime: startTime,
    EndTime: endTime,
    ElementValue: [{ Weather: description }],
  };
}

test('selectCwaDaytimeWeather prefers the daytime period when CWA still provides it', () => {
  const location = {
    WeatherElement: [{
      ElementName: '天氣現象',
      Time: [
        weatherPeriod('2026-09-09T06:00:00+08:00', '2026-09-09T18:00:00+08:00', '晴'),
        weatherPeriod('2026-09-09T18:00:00+08:00', '2026-09-10T06:00:00+08:00', '雨'),
      ],
    }],
  };

  assert.equal(selectCwaDaytimeWeather(location, '2026-09-09'), 'sunny');
});

test('selectCwaDaytimeWeather uses the remaining same-day period after CWA drops the elapsed daytime period', () => {
  const location = {
    WeatherElement: [{
      ElementName: '天氣現象',
      Time: [
        weatherPeriod('2026-09-09T18:00:00+08:00', '2026-09-10T06:00:00+08:00', '多雲'),
        weatherPeriod('2026-09-10T06:00:00+08:00', '2026-09-10T18:00:00+08:00', '雨'),
      ],
    }],
  };

  assert.equal(selectCwaDaytimeWeather(location, '2026-09-09'), 'cloudy');
});
