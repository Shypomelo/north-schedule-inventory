import React, { useMemo, useRef } from 'react';
import { addDays, differenceInDays, format, isAfter, isBefore, max, min, parseISO, startOfDay } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { Project, Contractor } from '@/lib/db/types';

interface GanttChartProps {
  projects: Project[];
  contractors: Contractor[];
  onProjectClick?: (project: Project) => void;
}

const CONTRACTOR_TYPES = [
  { key: 'racking', label: '支架', color: 'bg-emerald-500', bgLight: 'bg-emerald-500/20', border: 'border-emerald-500' },
  { key: 'electrical', label: '電力', color: 'bg-blue-500', bgLight: 'bg-blue-500/20', border: 'border-blue-500' },
  { key: 'steel', label: '鋼構', color: 'bg-purple-500', bgLight: 'bg-purple-500/20', border: 'border-purple-500' },
  { key: 'roof_cover', label: '新設頂蓋', color: 'bg-orange-500', bgLight: 'bg-orange-500/20', border: 'border-orange-500' },
  { key: 'civil', label: '土木', color: 'bg-amber-500', bgLight: 'bg-amber-500/20', border: 'border-amber-500' },
  { key: 'other', label: '其他', color: 'bg-slate-500', bgLight: 'bg-slate-500/20', border: 'border-slate-500' },
];

export function GanttChart({ projects, contractors, onProjectClick }: GanttChartProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
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
    const valid: any[] = [];
    const invalid: any[] = [];
    for (const t of tasks) {
      if (t.hasStart && t.hasEnd) {
        // Parse dates safely
        const start = parseISO(t.startDateStr);
        const end = parseISO(t.endDateStr);
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          valid.push({ ...t, start: startOfDay(start), end: startOfDay(end), conflicts: [] });
          continue;
        }
      }
      // If it reaches here, it has a start date but no end date, or invalid parsing
      invalid.push(t);
    }

    // Detect overlaps among valid tasks
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const t1 = valid[i];
        const t2 = valid[j];
        
        // Check if same contractor and they overlap (but ignore if it's the same project)
        if (t1.contractor && t2.contractor && t1.contractor.id === t2.contractor.id && t1.project.id !== t2.project.id) {
          if (t1.start <= t2.end && t1.end >= t2.start) {
            t1.conflicts.push(t2);
            t2.conflicts.push(t1);
          }
        }
      }
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

  const conflictingContractors = useMemo(() => {
    const conflictMap = new Map<string, any[]>();
    validTasks.forEach(t => {
      if (t.conflicts && t.conflicts.length > 0 && t.contractor) {
        if (!conflictMap.has(t.contractor.id)) {
          conflictMap.set(t.contractor.id, []);
        }
        conflictMap.get(t.contractor.id)!.push(t);
      }
    });
    return Array.from(conflictMap.entries()).map(([id, tasks]) => ({
      contractor: tasks[0].contractor,
      tasks: tasks.sort((a, b) => a.start.getTime() - b.start.getTime())
    }));
  }, [validTasks]);

  const handleProjectLeftClick = (projectId: string) => {
    const projectRow = groupedByProject.find(p => p[0] === projectId);
    if (!projectRow || !scrollContainerRef.current) return;
    
    const tasks = projectRow[1];
    if (tasks.length === 0) return;
    
    // Find earliest start date for this project
    const earliestStart = min(tasks.map(t => t.start));
    const startOffset = differenceInDays(earliestStart, minDate);
    
    // Calculate scroll position (40px per day, minus some padding)
    const scrollPos = Math.max(0, startOffset * 40 - 120);
    
    scrollContainerRef.current.scrollTo({
      left: scrollPos,
      behavior: 'smooth'
    });
  };

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

      {/* Conflict Warning Section */}
      {conflictingContractors.length > 0 && (
        <div className="bg-orange-500/10 border border-orange-500/50 rounded-xl p-4 mb-4 flex-shrink-0 shadow-lg shadow-orange-500/5">
          <h3 className="text-orange-400 font-bold mb-3 flex items-center gap-2">
            <AlertTriangle size={18} /> 發現包商撞期（同一包商在不同案場或工種的施工期間重疊）：
          </h3>
          <div className="flex flex-col gap-3 text-sm text-orange-200/80">
            {conflictingContractors.map((c, idx) => (
              <div key={idx} className="bg-orange-500/20 px-3 py-2.5 rounded-lg flex flex-col gap-2">
                <span className="font-bold text-orange-300 text-base">[{c.contractor.name}]</span>
                <div className="flex flex-wrap gap-2">
                  {c.tasks.map((t: any, i: number) => (
                    <div key={i} className="bg-slate-900/60 px-2 py-1 rounded border border-orange-500/30 flex items-center gap-2">
                      <button 
                        onClick={() => document.getElementById(`gantt-project-${t.project.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                        className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer"
                      >
                        {t.project.name} ({t.type.label})
                      </button>
                      <span className="text-orange-300/80 text-xs">
                        {format(t.start, 'yyyy/MM/dd')} ~ {format(t.end, 'yyyy/MM/dd')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gantt Chart Container */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto rounded-xl border border-slate-700/50 bg-slate-800/20 shadow-xl relative">
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
                <div key={projectId} id={`gantt-project-${projectId}`} className="flex border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors relative">
                  {/* Left fixed column */}
                  <div className="w-48 flex-shrink-0 border-r border-slate-700/50 p-3 sticky left-0 z-10 bg-slate-800/95 backdrop-blur font-medium text-slate-200">
                    <button 
                      onClick={() => handleProjectLeftClick(projectId)}
                      className="truncate hover:text-emerald-400 hover:underline cursor-pointer text-left w-full block" 
                      title={project.name}
                    >
                      {project.name}
                    </button>
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
                      
                      const hasConflict = t.conflicts && t.conflicts.length > 0;
                      let tooltipText = `${t.type.label} (${t.contractor?.name || '未指定包商'})\n${format(t.start, 'yyyy/MM/dd')} - ${format(t.end, 'yyyy/MM/dd')}`;
                      if (hasConflict) {
                        tooltipText += `\n\n⚠️ 撞期警告：\n此包商在重疊期間也被安排於：\n` + 
                          t.conflicts.map((c: any) => `- ${c.project.name} (${c.type.label})`).join('\n');
                      }

                      return (
                        <div
                          key={`${projectId}-${t.type.key}`}
                          className={`absolute h-6 rounded-md shadow-sm border flex items-center px-2 text-xs text-white truncate cursor-pointer transition-transform hover:-translate-y-0.5 ${hasConflict ? 'border-orange-400 border-2 bg-orange-500/80 !text-white animate-pulse' : `${t.type.color} ${t.type.border}`}`}
                          style={{
                            left: `${leftPos}px`,
                            width: `${width}px`,
                            top: `${topOffset}px`
                          }}
                          title={tooltipText}
                          onClick={() => onProjectClick?.(t.project)}
                        >
                          {hasConflict && <AlertTriangle size={12} className="mr-1 text-white shrink-0" />}
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
