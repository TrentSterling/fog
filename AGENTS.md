# Working on FogLab

## Preserve work remotely

Trent wants long editing sessions protected by frequent GitHub checkpoints.

- Inspect the current branch, remote head, and local changes before editing. Preserve work from other sessions.
- Use a remote work branch for changes that are still under validation. Keep the last verified release on `main` until the upgrade passes its checks.
- Commit and push meaningful milestones, including before a long validation or refactor. Do not leave a substantial upgrade only in a transient workspace.
- Verify the remote branch points to the saved commit. Report the checkpoint link during long turns.
- Make a new commit for fixes. Do not force-push, rewrite shared history, or discard unrelated changes.
- If remote saving is unavailable, say so promptly and preserve a recoverable local commit or patch. Do not claim unsaved work is backed up.

## Validate and release

- The build needs Node 22 or newer and no dependency installation.
- Run `npm test`, `npm run build`, and `npm run check` before promoting a release to `main`.
- Keep `dist/index.html` and `dist/FogLab.html` identical and self-contained, including the embedded worker and license notices.
- Keep CPU, GPU, and analytical comparison views on the same completed simulation tick. Worker failure or reset must not expose stale fields as current results.
- Preserve the existing approved appearance unless a visual change is requested.
- Describe what was actually tested. A setup-only browser without WebGL cannot validate live rendering or GPU performance.
- Verify publishing separately from the source push. A passing build or a pushed commit does not establish that `https://tront.xyz/fog/` is live.

## Attribution

Maintain `CREDITS.md`, `THIRD_PARTY_NOTICES.md`, and the offline Credits panel. Keep the original reference video, research attribution, and full Three.js MIT notice. Do not guess a reference creator's identity or claim Nintendo's implementation is known.
