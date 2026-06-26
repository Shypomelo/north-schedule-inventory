# Agent Rules

- Next.js Dev Server Quirks: When running `npm run build` or performing major updates, the Next.js `.next` cache can get corrupted, resulting in `Cannot find module './xxx.js'` errors in the browser. Always remember to kill the existing dev server, delete the `.next` folder (`Remove-Item -Recurse -Force .next` on Windows), and restart `npm run dev` after compiling/building to prevent module not found errors.
