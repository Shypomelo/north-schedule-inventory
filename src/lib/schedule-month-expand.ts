export const toggleExpandedMonthWeek = (
  currentWeekStart: string | null,
  selectedWeekStart: string,
): string | null => (
  currentWeekStart === selectedWeekStart ? null : selectedWeekStart
);

export const collapseExpandedMonthWeek = (): null => null;

export type MonthScheduleWeek = {
  key: string;
  startDate: Date;
  endDate: Date;
  calendarDays: Date[];
  scheduleDays: Date[];
};

const toLocalDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const buildMonthScheduleWeeks = (
  monthDays: Date[],
  calendarDaysPerWeek = 7,
  scheduleDaysPerWeek = 6,
): MonthScheduleWeek[] => Array.from(
  { length: Math.floor(monthDays.length / calendarDaysPerWeek) },
  (_, weekIndex) => {
    const calendarDays = monthDays.slice(
      weekIndex * calendarDaysPerWeek,
      (weekIndex + 1) * calendarDaysPerWeek,
    );
    const scheduleDays = calendarDays.slice(0, scheduleDaysPerWeek);
    const startDate = calendarDays[0];

    return {
      key: toLocalDateKey(startDate),
      startDate,
      endDate: scheduleDays[scheduleDays.length - 1],
      calendarDays,
      scheduleDays,
    };
  },
);

export const getMonthDaySummaryCounts = (taskCount: number, limit = 8) => ({
  visibleCount: Math.min(taskCount, limit),
  hiddenCount: Math.max(taskCount - limit, 0),
});
