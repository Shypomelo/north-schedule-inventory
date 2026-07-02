const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/components/ProjectDetailModal.tsx');
let content = fs.readFileSync(file, 'utf8');

// 1. Add date-fns imports if needed
if (!content.includes('parseISO')) {
  content = content.replace(
    /import { X, Building2, Wrench, Calendar, FileText, Plus } from 'lucide-react';/,
    "import { X, Building2, Wrench, Calendar, FileText, Plus, AlertTriangle } from 'lucide-react';\nimport { parseISO, format } from 'date-fns';"
  );
}

// 2. Add allProjects state
if (!content.includes('const [allProjects, setAllProjects]')) {
  content = content.replace(
    /const \[contractors, setContractors\] = useState\<Contractor\[\]\>\(\[\]\);/,
    "const [contractors, setContractors] = useState<Contractor[]>([]);\n  const [allProjects, setAllProjects] = useState<Project[]>([]);"
  );
}

// 3. Fetch all projects in useEffect
if (!content.includes('const allActiveProjects = await dbAdapter.getProjects();')) {
  content = content.replace(
    /const allContractors = await dbAdapter\.getContractors\(\);\n      setContractors\(allContractors\.filter\(c => c\.is_active\)\);/,
    `const allContractors = await dbAdapter.getContractors();\n      setContractors(allContractors.filter(c => c.is_active));\n      \n      const allActiveProjects = await dbAdapter.getProjects();\n      setAllProjects(allActiveProjects.filter(p => p.is_active && p.id !== project.id));`
  );
}

// 4. Add checkConflict function
const conflictFn = `
  const getConflictWarning = (typeKey: string) => {
    const contractorId = editedProject[\`\${typeKey}_contractor_id\` as keyof Project];
    const startStr = editedProject[\`\${typeKey}_expected_start_date\` as keyof Project] as string;
    const endStr = editedProject[\`\${typeKey}_completion_date\` as keyof Project] as string;
    
    if (!contractorId || !startStr || !endStr) return null;

    const startDate = parseISO(startStr);
    const endDate = parseISO(endStr);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null;

    for (const p of allProjects) {
      for (const t of CONTRACTOR_TYPES) {
        if (p[\`\${t.key}_contractor_id\` as keyof Project] === contractorId) {
          const pStart = p[\`\${t.key}_expected_start_date\` as keyof Project] as string;
          const pEnd = p[\`\${t.key}_completion_date\` as keyof Project] as string;
          if (pStart && pEnd) {
            const psDate = parseISO(pStart);
            const peDate = parseISO(pEnd);
            if (!isNaN(psDate.getTime()) && !isNaN(peDate.getTime())) {
              // start1 <= end2 && start2 <= end1
              if (startDate.getTime() <= peDate.getTime() && psDate.getTime() <= endDate.getTime()) {
                 const contractor = contractors.find(c => c.id === contractorId);
                 return \`撞期警示：\${contractor?.name} 已於「\${p.name}」安排施工 (\${format(psDate, 'MM/dd')} ~ \${format(peDate, 'MM/dd')})\`;
              }
            }
          }
        }
      }
    }
    return null;
  };
`;

if (!content.includes('const getConflictWarning =')) {
  content = content.replace(
    /const getContractorDetails = \(id: string \| null\) => \{/,
    conflictFn + "\n  const getContractorDetails = (id: string | null) => {"
  );
}

// 5. Render warning in renderProgress
const renderProgressRegex = /onChange=\{e => handleSave\(\{ \[endField\]: e\.target\.value \}\)\}\n\s*disabled=\{currentUser\?\.role === 'VIEWER'\}\n\s*\/>\n\s*<\/div>\n\s*<\/div>/g;

if (!content.includes('getConflictWarning(type.key)')) {
  content = content.replace(renderProgressRegex, `onChange={e => handleSave({ [endField]: e.target.value })}\n                disabled={currentUser?.role === 'VIEWER'}\n              />\n            </div>\n          </div>\n          {getConflictWarning(type.key) && (\n            <div className="flex items-center gap-2 mt-2 px-4 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-400 text-xs ml-[112px] animate-in slide-in-from-top-1">\n              <AlertTriangle size={14} />\n              {getConflictWarning(type.key)}\n            </div>\n          )}`);
}

// We should also render warning in renderContractors just in case they set dates but then change the contractor!
const renderContractorRegex = /<div>\n\s*<label className="block text-xs text-slate-400 mb-1">電話<\/label>[\s\S]*?<\/div>\n\s*<\/div>\n\s*<\/div>/g;

if (!content.includes('getConflictWarning(type.key) && (<div className="mt-4 px-4 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-400 text-xs animate-in slide-in-from-top-1 flex items-center gap-2">')) {
  content = content.replace(renderContractorRegex, (match) => {
    return match + `\n            {getConflictWarning(type.key) && (\n              <div className="mt-4 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-400 text-xs animate-in slide-in-from-top-1 flex items-center gap-2">\n                <AlertTriangle size={14} className="shrink-0" />\n                {getConflictWarning(type.key)}\n              </div>\n            )}`;
  });
}

fs.writeFileSync(file, content, 'utf8');
console.log('Successfully patched ProjectDetailModal.tsx');
