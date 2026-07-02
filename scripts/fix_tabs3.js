const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(file, 'utf8');

// 1. Add import for GanttChart
if (!content.includes('GanttChart')) {
  content = content.replace(
    /import { ProjectDetailModal } from '@\/components\/ProjectDetailModal';/,
    "import { ProjectDetailModal } from '@/components/ProjectDetailModal';\nimport { GanttChart } from '@/components/GanttChart';"
  );
}

// 2. Add activeTab state
if (!content.includes('const [activeTab')) {
  content = content.replace(
    /const \[viewingProject, setViewingProject\] = useState<Project \| null>\(null\);/,
    "const [viewingProject, setViewingProject] = useState<Project | null>(null);\n  const [activeTab, setActiveTab] = useState<'report' | 'gantt'>('report');"
  );
}

// 3. Define empty contractors
if (!content.includes('const contractors = []')) {
  content = content.replace(
    /const \[activeTab, setActiveTab\] = useState\<'report' \| 'gantt'\>\('report'\);/,
    "const [activeTab, setActiveTab] = useState<'report' | 'gantt'>('report');\n  const contractors: any[] = [];"
  );
}

fs.writeFileSync(file, content, 'utf8');
console.log('Successfully added missing state and imports');
