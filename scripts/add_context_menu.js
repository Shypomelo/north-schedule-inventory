const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let pageContent = fs.readFileSync(pagePath, 'utf8');

// 1. Add ContextMenu state
const stateInsertion = `  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, project: Project } | null>(null);

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);`;
pageContent = pageContent.replace(/const \[viewingProject, setViewingProject\] = useState<Project \| null>\(null\);/, `const [viewingProject, setViewingProject] = useState<Project | null>(null);\n${stateInsertion}`);

// 2. Modify renderActiveTable tr
pageContent = pageContent.replace(/<tr key=\{project\.id\} className="hover:bg-slate-800\/50 transition-colors group">/, `<tr 
                    key={project.id} 
                    className="hover:bg-slate-800/50 transition-colors group cursor-context-menu"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, project });
                    }}
                  >`);

// 3. Handle Archive
const archiveLogic = `
  const handleArchiveProject = async (project: Project) => {
    if (!confirm(\`確定要作廢「\${project.name}」嗎？\`)) return;
    try {
      await dbAdapter.updateProject(project.id, { status: '作廢' });
      await fetchProjects();
    } catch (e) {
      alert('操作失敗');
    }
  };
`;
pageContent = pageContent.replace(/const handleCompleteProject = async/, `${archiveLogic}\n  const handleCompleteProject = async`);

// 4. Render context menu at the end
const contextMenuRender = `
      {contextMenu && (
        <div 
          className="fixed z-[100] w-48 bg-slate-800 border border-slate-700/60 rounded-xl shadow-2xl py-2"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={() => { setViewingProject(contextMenu.project); setContextMenu(null); }}
          >
            詳細資料
          </button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={() => { alert('改期功能規劃中'); setContextMenu(null); }}
          >
            改期
          </button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-emerald-400 text-sm border-t border-slate-700/50 mt-1 pt-2"
            onClick={() => { handleCompleteProject(contextMenu.project); setContextMenu(null); }}
          >
            結案
          </button>
          <button 
            className="w-full text-left px-4 py-2 hover:bg-slate-700 text-rose-400 text-sm"
            onClick={() => { handleArchiveProject(contextMenu.project); setContextMenu(null); }}
          >
            作廢 / 停用
          </button>
        </div>
      )}
`;
pageContent = pageContent.replace(/<\/div>\s*$/, `${contextMenuRender}\n    </div>`);

fs.writeFileSync(pagePath, pageContent, 'utf8');
console.log('Context menu added');
