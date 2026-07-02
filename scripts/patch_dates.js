const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(pagePath, 'utf8');

// 1. Add import
if (!content.includes('DateDualInput')) {
  content = content.replace(
    /import \{ SmartDateInput \} from '@\/components\/SmartDateInput';/,
    `import { SmartDateInput } from '@/components/SmartDateInput';\nimport { DateDualInput } from '@/components/DateDualInput';`
  );
}

// 2. Add handleProjectDatesChange
if (!content.includes('handleProjectDatesChange')) {
  content = content.replace(
    /const handleProjectInlineChange = async/,
    `const handleProjectDatesChange = async (id: string, updates: Partial<Project>) => {
    try {
      setSaveStatus('儲存中');
      setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates } as Project : p));
      
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await dbAdapter.updateProject(id, updates);
          setSaveStatus('已儲存');
          setTimeout(() => setSaveStatus(''), 2000);
        } catch (error) {
          console.error("Failed to update project dates", error);
          setSaveStatus('儲存失敗');
        }
      }, 1000);
    } catch (e) {
      console.error(e);
      setSaveStatus('儲存失敗');
    }
  };

  const handleProjectInlineChange = async`
  );
}

// 3. Remove "改期" button from contextMenu
content = content.replace(
  /<button \s*className="w-full text-left px-4 py-2 hover:bg-slate-700 text-slate-200 text-sm"\s*onClick=\{\(\) => \{ alert\('改期功能規劃中'\); setContextMenu\(null\); \}\}\s*>\s*改期\s*<\/button>/g,
  ''
);

// 4. Replace SmartDateInput inside renderActiveTable with DateDualInput
// For bracket
content = content.replace(
  /<SmartDateInput \s*disabled=\{currentUser\?\.role === 'VIEWER'\}\s*value=\{project\.bracket_status \|\| ''\}\s*baseDate=\{project\.report_base_date \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\}\s*onChange=\{\(val\) => handleProjectInlineChange\(project\.id, 'bracket_status', val\)\}\s*\/>/g,
  `<DateDualInput 
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.racking_expected_start_date || null}
                      completionDate={project.racking_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { racking_expected_start_date: exp, racking_completion_date: comp })}
                    />`
);

// For power
content = content.replace(
  /<SmartDateInput \s*disabled=\{currentUser\?\.role === 'VIEWER'\}\s*value=\{project\.power_status \|\| ''\}\s*baseDate=\{project\.report_base_date \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\}\s*onChange=\{\(val\) => handleProjectInlineChange\(project\.id, 'power_status', val\)\}\s*\/>/g,
  `<DateDualInput 
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.electrical_expected_start_date || null}
                      completionDate={project.electrical_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { electrical_expected_start_date: exp, electrical_completion_date: comp })}
                    />`
);

// For inspection
content = content.replace(
  /<SmartDateInput \s*disabled=\{currentUser\?\.role === 'VIEWER'\}\s*value=\{project\.inspection_status \|\| ''\}\s*baseDate=\{project\.report_base_date \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\}\s*onChange=\{\(val\) => handleProjectInlineChange\(project\.id, 'inspection_status', val\)\}\s*\/>/g,
  `<DateDualInput 
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.inspection_expected_date || null}
                      completionDate={project.inspection_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { inspection_expected_date: exp, inspection_completion_date: comp })}
                    />`
);

// For meter
content = content.replace(
  /<SmartDateInput \s*disabled=\{currentUser\?\.role === 'VIEWER'\}\s*value=\{project\.meter_status \|\| ''\}\s*baseDate=\{project\.report_base_date \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\}\s*onChange=\{\(val\) => handleProjectInlineChange\(project\.id, 'meter_status', val\)\}\s*\/>/g,
  `<DateDualInput 
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.meter_expected_date || null}
                      completionDate={project.meter_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { meter_expected_date: exp, meter_completion_date: comp })}
                    />`
);

// For roof
content = content.replace(
  /<SmartDateInput \s*disabled=\{currentUser\?\.role === 'VIEWER'\}\s*value=\{project\.roof_status \|\| ''\}\s*baseDate=\{project\.report_base_date \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\}\s*onChange=\{\(val\) => handleProjectInlineChange\(project\.id, 'roof_status', val\)\}\s*\/>/g,
  `<DateDualInput 
                      disabled={currentUser?.role === 'VIEWER'}
                      expectedDate={project.roof_cover_expected_start_date || null}
                      completionDate={project.roof_cover_completion_date || null}
                      onChange={(exp, comp) => handleProjectDatesChange(project.id, { roof_cover_expected_start_date: exp, roof_cover_completion_date: comp })}
                    />`
);

fs.writeFileSync(pagePath, content, 'utf8');
console.log('Done modifying page.tsx for dates');
