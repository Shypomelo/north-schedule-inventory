const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let pageContent = fs.readFileSync(pagePath, 'utf8');

pageContent = pageContent.replace(/const handleActiveProjectInlineChange = \(id: string, field: keyof.*?(?=\n\s*const handleDelete)/s, `const handleProjectInlineChange = async (id: string, field: string, value: string) => {
    try {
      setSaveStatus('儲存中');
      const updatedProjects = projects.map(p => p.id === id ? { ...p, [field]: value } as Project : p);
      setProjects(updatedProjects);
      
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await dbAdapter.updateProject(id, { [field]: value });
          setSaveStatus('已儲存');
          setTimeout(() => setSaveStatus(''), 2000); // clear after 2 seconds
        } catch (error) {
          console.error(error);
          setSaveStatus('儲存失敗');
        }
      }, 500);
    } catch (e) {
      console.error(e);
      setSaveStatus('儲存失敗');
    }
  };
`);

pageContent = pageContent.replace(/handleActiveProjectInlineChange/g, 'handleProjectInlineChange');
pageContent = pageContent.replace(/setActiveProjects/g, 'setProjects'); // in case it's still somewhere

fs.writeFileSync(pagePath, pageContent, 'utf8');
console.log('Fixed handleActiveProjectInlineChange');
