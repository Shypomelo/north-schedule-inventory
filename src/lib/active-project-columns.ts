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
  { key: 'bracket', width: 136 },
  { key: 'power', width: 136 },
  { key: 'inspection', width: 136 },
  { key: 'meter', width: 136 },
  { key: 'roof', width: 136 },
  { key: 'startDate', width: 136 },
  { key: 'notes', width: 260 },
];

export function getActiveProjectColumns(options: ActiveProjectColumnOptions): ActiveProjectColumn[] {
  return [
    { key: 'actions', width: 64 },
    { key: 'code', width: 112 },
    { key: 'name', width: 220 },
    { key: 'capacity', width: 88 },
    { key: 'manager', width: 120 },
    ...(options.showBracket ? [{ key: 'bracket', width: 136 }] : []),
    ...(options.showPower ? [{ key: 'power', width: 136 }] : []),
    ...(options.showInspection ? [{ key: 'inspection', width: 136 }] : []),
    ...(options.showMeter ? [{ key: 'meter', width: 136 }] : []),
    ...(options.showRoof ? [{ key: 'roof', width: 136 }] : []),
    ...(options.showStartDate ? [{ key: 'startDate', width: 136 }] : []),
    { key: 'notes', width: 260 },
    ...(options.showComplete ? [{ key: 'complete', width: 88 }] : []),
  ];
}
