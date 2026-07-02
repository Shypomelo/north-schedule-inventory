const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(file, 'utf8');

const targetStr = `{renderActiveTable("1. 目前施工中案件", activeCategories.section1)}
            {renderActiveTable("2. 下兩周預計進場之案件", activeCategories.section2)}
            {renderActiveTable("3. 其他負責案件", activeCategories.section3)}
            {renderActiveTable("4. 前兩周掛表案件", activeCategories.section4)}`;

const newStr = `
            <div className="flex gap-4 mb-6 border-b border-slate-700/50 pb-2">
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
              <div className="h-[calc(100vh-250px)]">
                <GanttChart projects={filteredProjects} contractors={contractors} />
              </div>
            )}
`;

if (content.includes(targetStr)) {
  content = content.replace(targetStr, newStr);
  fs.writeFileSync(file, content, 'utf8');
  console.log('Successfully added Gantt tabs via script');
} else {
  console.log('Could not find target string');
}
