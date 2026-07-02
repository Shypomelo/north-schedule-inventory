const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let pageContent = fs.readFileSync(pagePath, 'utf8');

// Fix viewingActiveProject state
pageContent = pageContent.replace(/const \[viewingsetViewingActiveProject/g, 'const [viewingActiveProject, setViewingActiveProject'); // fix typo if I caused it
pageContent = pageContent.replace(/const \[viewingActiveProject, setViewingActiveProject\].*/, 'const [viewingActiveProject, setViewingActiveProject] = useState<Project | null>(null);');

// Add Project import
pageContent = pageContent.replace(/import \{ Project, User \} from '@\/lib\/db\/types';/, "import { Project, User } from '@/lib/db/types';");
pageContent = pageContent.replace(/ActiveProject/g, 'Project'); // Just replace any lingering ActiveProject

// Fix Omit<Project, 'id' | 'created_at' | 'updated_at'> (Wait, Omit requires 2 args, but Omit<T, K> is 2 args. Ah! I wrote `Omit<Project, 'id' | 'created_at' | 'updated_at'>` which is 2 args. Why did it say generic type requires 2 args? Maybe I wrote `Omit<'id'|...>` somewhere? Let's fix that)
pageContent = pageContent.replace(/Omit<'id' \| 'created_at' \| 'updated_at'>/g, "Omit<Project, 'id' | 'created_at' | 'updated_at'>");

// Fix parseDateField undefined -> string
pageContent = pageContent.replace(/const meterDate = parseDateField\(p\.meter_status, baseDateStr\);/g, 'const meterDate = parseDateField(p.meter_status || "", baseDateStr);');
pageContent = pageContent.replace(/const bracketDate = parseDateField\(p\.bracket_status, baseDateStr\);/g, 'const bracketDate = parseDateField(p.bracket_status || "", baseDateStr);');
pageContent = pageContent.replace(/const powerDate = parseDateField\(p\.power_status, baseDateStr\);/g, 'const powerDate = parseDateField(p.power_status || "", baseDateStr);');
pageContent = pageContent.replace(/hasCompletedText\(p\.bracket_status\)/g, 'hasCompletedText(p.bracket_status || "")');
pageContent = pageContent.replace(/hasCompletedText\(p\.power_status\)/g, 'hasCompletedText(p.power_status || "")');

fs.writeFileSync(pagePath, pageContent, 'utf8');

const mockPath = path.join(__dirname, '../src/lib/db/mock.ts');
let mockContent = fs.readFileSync(mockPath, 'utf8');
mockContent = mockContent.replace(/Omit<'id'\|'created_at'\|'updated_at'>/g, "Omit<Project, 'id'|'created_at'|'updated_at'>");
fs.writeFileSync(mockPath, mockContent, 'utf8');

console.log('Fixed page and mock');
