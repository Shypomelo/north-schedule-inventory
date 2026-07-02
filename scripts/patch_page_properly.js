const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(pagePath, 'utf8');

// 1. Add contextMenu state
content = content.replace(
  /const \[viewingProject, setViewingProject\] = useState<Project \| null>\(null\);/,
  `const [viewingProject, setViewingProject] = useState<Project | null>(null);\n  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, project: Project } | null>(null);\n\n  useEffect(() => {\n    const handleClickOutside = () => setContextMenu(null);\n    document.addEventListener('click', handleClickOutside);\n    return () => document.removeEventListener('click', handleClickOutside);\n  }, []);`
);

// 2. Add handleArchiveProject below handleCompleteProject
content = content.replace(
  /const handleProjectInlineChange = async/,
  `const handleArchiveProject = async (project: Project) => {\n    if (!confirm(\`確定要停用 / 作廢「\${project.name}」嗎？\`)) return;\n    try {\n      await dbAdapter.updateProject(project.id, { status: '作廢' });\n      await fetchProjects();\n    } catch (e) {\n      alert('操作失敗');\n    }\n  };\n\n  const handleProjectInlineChange = async`
);

// 3. Update the <tr> inside renderActiveTable
content = content.replace(
  /className="hover:bg-slate-700\/40 transition-colors group"/g,
  `className="hover:bg-slate-700/40 transition-colors group cursor-context-menu"`
);
content = content.replace(
  /handleDeleteProject\(project\);/g,
  `setContextMenu({ x: e.clientX, y: e.clientY, project });`
);

// 4. Wrap the main return in <> and append contextMenu HTML
content = content.replace(
  /return \(\s*<div className="p-8 min-w-\[1600px\] mx-auto flex flex-col h-full">/,
  `return (\n    <>\n      <div className="p-8 min-w-[1600px] mx-auto flex flex-col h-full">`
);

content = content.replace(
  /(\s*)<\/div>\s*\)\;\s*\}\s*$/,
  `$1</div>\n      {contextMenu && (\n        <div \n          className="fixed z-[100] w-48 bg-slate-800 border border-slate-700/60 rounded-xl shadow-2xl py-2"\n          style={{ top: contextMenu.y, left: contextMenu.x }}\n          onClick={(e) => e.stopPropagation()}\n        >\n          <button \n            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-slate-200 text-sm"\n            onClick={() => { setViewingProject(contextMenu.project); setContextMenu(null); }}\n          >\n            詳細資料\n          </button>\n          <button \n            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-slate-200 text-sm"\n            onClick={() => { alert('改期功能規劃中'); setContextMenu(null); }}\n          >\n            改期\n          </button>\n          <button \n            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-emerald-400 text-sm border-t border-slate-700/50 mt-1 pt-2"\n            onClick={() => { handleCompleteProject(contextMenu.project); setContextMenu(null); }}\n          >\n            結案\n          </button>\n          <button \n            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-rose-400 text-sm"\n            onClick={() => { handleArchiveProject(contextMenu.project); setContextMenu(null); }}\n          >\n            作廢 / 停用\n          </button>\n        </div>\n      )}\n    </>\n  );\n}\n`
);

fs.writeFileSync(pagePath, content, 'utf8');
console.log('Successfully patched page.tsx');
