import React, { useMemo } from 'react';
import { addDays, differenceInDays, format, isAfter, isBefore, max, min, parseISO, startOfDay } from 'date-fns';
import { Project, Contractor } from '@/lib/db/types';

interface GanttChartProps {
  projects: Project[];
  contractors: Contractor[];
}

const CONTRACTOR_TYPES = [
  { key: 'racking', label: '支架', color: 'bg-emerald-500', bgLight: 'bg-emerald-500/20', border: 'border-emerald-500' },
  { key: 'electrical', label: '電力', color: 'bg-blue-500', bgLight: 'bg-blue-500/20', border: 'border-blue-500' },
  { key: 'steel', label: '鋼構', color: 'bg-purple-500', bgLight: 'bg-purple-500/20', border: 'border-purple-500' },
  { key: 'roof_cover', label: '新設頂蓋', color: 'bg-orange-500', bgLight: 'bg-orange-500/20', border: 'border-orange-500' },
  { key: 'civil', label: '土木', color: 'bg-amber-500', bgLight: 'bg-amber-500/20', border: 'border-amber-500' },
  { key: 'other', label: '其他', color: 'bg-slate-500', bgLight: 'bg-slate-500/20', border: 'border-slate-500' },
];

export function GanttChart({ projects, contractors }: GanttChartProps) {
  // We want to extract all tasks across all projects
  const tasks = useMemo(() => {
    const extracted: any[] = [];
    projects.forEach(p => {
      CONTRACTOR_TYPES.forEach(type => {
        const statusField = `${type.key}_status` as keyof Project;
        const startField = `${type.key}_expected_start_date` as keyof Project;
        const endField = `${type.key}_completion_date` as keyof Project;
        const contractorIdField = `${type.key}_contractor_id` as keyof Project;
        
        if (p[statusField] === 'disabled') return;

        const startDateStr = p[startField] as string | null;
        const endDateStr = p[endField] as string | null;
        const contractorId = p[contractorIdField] as string | null;
        
        const contractor = contractors.find(c => c.id === contractorId);

        if (startDateStr) {
          extracted.push({
            project: p,
            type,
            startDateStr,
            endDateStr,
            contractor,
            hasStart: !!startDateStr,
            hasEnd: !!endDateStr,
          });
        }
      });
    });
    return extracted;
  }, [projects, contractors]);

  const { validTasks, invalidTasks } = useMemo(() => {
    const valid = [];
    const invalid = [];
    for (const t of tasks) {
      if (t.hasStart && t.hasEnd) {
        // Parse dates safely
        const start = parseISO(t.startDateStr);
        const end = parseISO(t.endDateStr);
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          valid.push({ ...t, start, end });
          continue;
        }
      }
      // If it reaches here, it has a start date but no end date, or invalid parsing
      invalid.push(t);
    }
    return { validTasks: valid, invalidTasks: invalid };
  }, [tasks]);

  const { minDate, maxDate, totalDays, dates } = useMemo(() => {
    if (validTasks.length === 0) {
      const today = startOfDay(new Date());
      return { minDate: today, maxDate: today, totalDays: 1, dates: [today] };
    }

    const starts = validTasks.map(t => t.start);
    const ends = validTasks.map(t => t.end);
    
    // Add some padding to the timeline (3 days before min, 7 days after max)
    const minD = addDays(min(starts), -3);
    const maxD = addDays(max(ends), 7);
    
    const days = differenceInDays(maxD, minD) + 1;
    const dArray = [];
    for (let i = 0; i < days; i++) {
      dArray.push(addDays(minD, i));
    }

    return { minDate: minD, maxDate: maxD, totalDays: days, dates: dArray };
  }, [validTasks]);

  // Group valid tasks by project for the timeline view
  const groupedByProject = useMemo(() => {
    const map = new Map<string, typeof validTasks>();
    validTasks.forEach(t => {
      if (!map.has(t.project.id)) map.set(t.project.id, []);
      map.get(t.project.id)!.push(t);
    });
    
    // Sort projects by their earliest task
    const sortedProjects = Array.from(map.entries()).sort((a, b) => {
      const minA = min(a[1].map(t => t.start));
      const minB = min(b[1].map(t => t.start));
      return minA.getTime() - minB.getTime();
    });
    
    return sortedProjects;
  }, [validTasks]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Warning Section for tasks without end dates */}
      {invalidTasks.length > 0 && (
        <div className="bg-rose-500/10 border border-rose-500/50 rounded-xl p-4 mb-4 flex-shrink-0">
          <h3 className="text-rose-400 font-bold mb-2 flex items-center gap-2">
            ⚠️ 以下工程因缺少「完工日期」而無法顯示於甘特圖：
          </h3>
          <div className="flex flex-wrap gap-2 text-sm text-rose-200/80">
            {invalidTasks.map((t, idx) => (
              <span key={idx} className="bg-rose-500/20 px-2 py-1 rounded">
                {t.project.name} - {t.type.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Gantt Chart Container */}
      <div className="flex-1 overflow-auto rounded-xl border border-slate-700/50 bg-slate-800/20 shadow-xl relative">
        {validTasks.length === 0 ? (
          <div className="p-8 text-center text-slate-400">目前沒有可顯示的排程資料（需有進場及完工日期）</div>
        ) : (
          <div className="inline-flex flex-col min-w-full">
            {/* Header Row (Dates) */}
            <div className="flex sticky top-0 z-20 bg-slate-800 border-b border-slate-700/50">
              <div className="w-48 flex-shrink-0 border-r border-slate-700/50 p-3 sticky left-0 z-30 bg-slate-800 font-medium text-slate-300">
                案場名稱
              </div>
              <div className="flex" style={{ width: `${totalDays * 40}px` }}>
                {dates.map((d, i) => {
                  const isToday = format(d, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                  return (
                    <div 
                      key={i} 
                      className={`w-[40px] flex-shrink-0 border-r border-slate-700/30 flex flex-col items-center justify-center text-xs ${isToday ? 'bg-emerald-500/20 text-emerald-400 font-bold' : 'text-slate-400'}`}
                    >
                      <span>{format(d, 'MM/dd')}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Body Rows (Projects) */}
            {groupedByProject.map(([projectId, projectTasks]) => {
              const project = projectTasks[0].project;
              return (
                <div key={projectId} className="flex border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors relative">
                  {/* Left fixed column */}
                  <div className="w-48 flex-shrink-0 border-r border-slate-700/50 p-3 sticky left-0 z-10 bg-slate-800/95 backdrop-blur font-medium text-slate-200">
                    <div className="truncate" title={project.name}>{project.name}</div>
                    <div className="text-xs text-slate-500 truncate">{project.manager || '未指定負責人'}</div>
                  </div>
                  
                  {/* Timeline track */}
                  <div className="flex relative" style={{ width: `${totalDays * 40}px` }}>
                    {/* Background grid lines */}
                    {dates.map((_, i) => (
                      <div key={i} className="w-[40px] flex-shrink-0 border-r border-slate-700/10" />
                    ))}

                    {/* Today indicator line */}
                    {dates.map((d, i) => {
                      if (format(d, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')) {
                        return (
                          <div 
                            key={`today-${i}`}
                            className="absolute top-0 bottom-0 w-px bg-emerald-500/50 z-0 pointer-events-none"
                            style={{ left: `${i * 40 + 20}px` }}
                          />
                        );
                      }
                      return null;
                    })}

                    {/* Task Bars */}
                    {projectTasks.map((t, idx) => {
                      // Calculate positions
                      const startOffset = differenceInDays(t.start, minDate);
                      const duration = differenceInDays(t.end, t.start) + 1; // Inclusive
                      const leftPos = startOffset * 40;
                      const width = duration * 40;
                      
                      // Handle potential overlap by offsetting top slightly if multiple tasks
                      const topOffset = 8 + (idx * 30); // Simple stacking, 
                      
                      // For simplicity, we just vertically stack tasks inside the row.
                      // That means the row needs to be tall enough to fit them all.
                      // We will set the row container's min-height based on number of tasks.

                      return (
                        <div
                          key={`${projectId}-${t.type.key}`}
                          className={`absolute h-6 rounded-md shadow-sm border flex items-center px-2 text-xs text-white truncate cursor-pointer transition-transform hover:-translate-y-0.5 ${t.type.color} ${t.type.border}`}
                          style={{
                            left: `${leftPos}px`,
                            width: `${width}px`,
                            top: `${topOffset}px`
                          }}
                          title={`${t.type.label} (${t.contractor?.name || '未指定包商'})\n${format(t.start, 'yyyy/MM/dd')} - ${format(t.end, 'yyyy/MM/dd')}`}
                        >
                          <span className="truncate font-medium">{t.type.label}</span>
                          {t.contractor && <span className="ml-1 opacity-80 truncate">- {t.contractor.name}</span>}
                        </div>
                      );
                    })}
                  </div>
                  
                  {/* Invisible spacer to ensure row is tall enough for all stacked tasks */}
                  <div style={{ height: `${projectTasks.length * 30 + 16}px` }} className="pointer-events-none w-0" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
