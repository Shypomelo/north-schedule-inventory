export const toggleExpandedMonthWeek = (
  currentWeekStart: string | null,
  selectedWeekStart: string,
): string | null => (
  currentWeekStart === selectedWeekStart ? null : selectedWeekStart
);

export const collapseExpandedMonthWeek = (): null => null;

export const getMonthDaySummaryCounts = (taskCount: number, limit = 8) => ({
  visibleCount: Math.min(taskCount, limit),
  hiddenCount: Math.max(taskCount - limit, 0),
});
