const tsNode = require('ts-node');
tsNode.register();
const { parseDateField } = require('./src/lib/utils/date-utils.ts');
console.log("預計07/16 parsed to:", parseDateField("預計07/16", "2026-07-14"));
console.log("實際07/01 parsed to:", parseDateField("實際07/01", "2026-07-14"));
