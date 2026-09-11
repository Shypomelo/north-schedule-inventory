# Agent Rules

- Keep the development server on `.next`. While `npm run dev` is running, use `npm run build:verify` for local production-build verification; it builds into `.next-verify` and must not modify `.next`.
- `npm run build` is the deployment/production contract. Its guard rejects a local build when the managed dev server is using `.next`. Stop dev first if a default-output production build is explicitly required.
- If an older/unmanaged process has already corrupted `.next` (missing chunks, `ChunkLoadError`, or an infinite `系統載入中...` screen), stop that exact dev PID, remove only the candidate worktree's `.next`, then restart with `npm run dev`.
