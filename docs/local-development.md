# Local development stability

Run the application with:

```powershell
npm run dev
```

The dev server owns `.next` and writes `.next-dev.lock` while it is running.

For a production-mode verification while localhost remains available, run:

```powershell
npm run build:verify
```

This invokes the normal Next.js production builder with `NEXT_DIST_DIR=.next-verify`. It does not change the default Vercel/production contract: `npm run build` still builds into `.next` when no dev server is running.

Do not run `next build` directly while dev is running. `npm run build` detects the managed dev lock and refuses to overwrite `.next`; use `npm run build:verify` instead.

If `.next` was already corrupted by an older unmanaged process, stop that exact dev process, remove only this worktree's `.next`, and restart `npm run dev`. A blank page or permanent `系統載入中...` with a 404 under `/_next/static/chunks/app/` is evidence of this state.
