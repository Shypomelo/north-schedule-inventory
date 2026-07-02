const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(file, 'utf8');

// Use regex to replace the block
const regex = /<div className="pb-8">([\s\S]*?renderActiveTable\("4\. 前兩周掛表案件", activeCategories\.section4\)}[\s\S]*?)<\/div>/;

const newStr = `
          <div className="pb-8 flex flex-col h-full">
            <div className="flex gap-4 mb-6 border-b border-slate-700/50 pb-2 shrink-0">
              <button 
                onClick={() => setActiveTab('report')}
                className={\`px-4 py-2 font-medium transition-colors border-b-2 -mb-[10px] \${activeTab === 'report' ? 'text-emerald-400 border-emerald-500' : 'text-slate-400 border-transparent hover:text-slate-300'}\`}
              >
                週回報表
              </button>
              <button 
                onClick={() => setActiveTab('gantt')}
                className={\`px-4 py-2 font-medium transition-colors border-b-2 -mb-[10px] \${activeTab === 'gantt' ? 'text-emerald-400 border-emerald-500' : 'text-slate-400 border-transparent hover:text-slate-300'}\`}
              >
                包商排工 (甘特圖)
              </button>
            </div>

            {activeTab === 'report' ? (
              <>
                {renderActiveTable("1. 目前施工中案件", activeCategories.section1)}
                {renderActiveTable("2. 下兩周預計進場之案件", activeCategories.section2)}
                {renderActiveTable("3. 其他負責案件", activeCategories.section3)}
                {renderActiveTable("4. 前兩周掛表案件", activeCategories.section4)}
              </>
            ) : (
              <div className="flex-1 overflow-hidden min-h-[500px]">
                <GanttChart projects={filteredProjects} contractors={contractors} />
              </div>
            )}
          </div>
`;

if (regex.test(content)) {
  content = content.replace(regex, newStr);
  fs.writeFileSync(file, content, 'utf8');
  console.log('Regex replace successful');
} else {
  console.log('Regex replace failed');
}
