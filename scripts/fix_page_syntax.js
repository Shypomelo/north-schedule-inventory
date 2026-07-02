const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let content = fs.readFileSync(pagePath, 'utf8');

// Fix the return wrapper: add <> and </>
content = content.replace(/return \(\s*<div className="p-8 min-w-\[1600px\]/, 'return (\n    <>\n      <div className="p-8 min-w-[1600px]');
// The end is already `</>\n  );\n}` from the previous replacement because I appended `</>`.
// Wait, my replacement chunk appended `</>`, but there was no `<>`. Now it has `<>` at the start.

// Fix handleDeleteProject syntax error
content = content.replace(/const handleArchiveProject/g, `} catch (e) {
      console.error(e);
      alert('刪除失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleArchiveProject`);

fs.writeFileSync(pagePath, content, 'utf8');
console.log('Fixed page.tsx syntax');
