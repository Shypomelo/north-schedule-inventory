export interface ActiveProjectColumnOptions {
  showBracket: boolean;
  showPower: boolean;
  showInspection: boolean;
  showMeter: boolean;
  showRoof: boolean;
  showStartDate: boolean;
  showComplete: boolean;
}

export interface ActiveProjectColumn {
  key: string;
  width: number;
}

export const ACTIVE_PROJECT_SECTION_COLUMNS: readonly ActiveProjectColumn[] = [
  { key: 'actions', width: 64 },
  { key: 'code', width: 112 },
  { key: 'name', width: 220 },
  { key: 'capacity', width: 88 },
  { key: 'manager', width: 120 },
  { key: 'bracket', width: 160 },
  { key: 'power', width: 160 },
  { key: 'inspection', width: 160 },
  { key: 'meter', width: 160 },
  { key: 'roof', width: 160 },
  { key: 'startDate', width: 160 },
  { key: 'notes', width: 260 },
];

export function getActiveProjectColumns(options: ActiveProjectColumnOptions): ActiveProjectColumn[] {
  return [
    { key: 'actions', width: 64 },
    { key: 'code', width: 112 },
    { key: 'name', width: 220 },
    { key: 'capacity', width: 88 },
    { key: 'manager', width: 120 },
    ...(options.showBracket ? [{ key: 'bracket', width: 160 }] : []),
    ...(options.showPower ? [{ key: 'power', width: 160 }] : []),
    ...(options.showInspection ? [{ key: 'inspection', width: 160 }] : []),
    ...(options.showMeter ? [{ key: 'meter', width: 160 }] : []),
    ...(options.showRoof ? [{ key: 'roof', width: 160 }] : []),
    ...(options.showStartDate ? [{ key: 'startDate', width: 160 }] : []),
    { key: 'notes', width: 260 },
    ...(options.showComplete ? [{ key: 'complete', width: 88 }] : []),
  ];
}
