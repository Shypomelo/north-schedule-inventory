export const toggleExpandedMonthWeek = (
  currentWeekStart: string | null,
  selectedWeekStart: string,
): string | null => (
  currentWeekStart === selectedWeekStart ? null : selectedWeekStart
);

export const collapseExpandedMonthWeek = (): null => null;
