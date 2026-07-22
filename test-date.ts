import { parseDateField } from './src/lib/utils/date-utils';
console.log("預計07/16 parsed to:", parseDateField("預計07/16", "2026-07-14"));
console.log("實際07/01 parsed to:", parseDateField("實際07/01", "2026-07-14"));
