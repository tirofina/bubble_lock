# Final scoped verification

Captured 2026-10-29. Base commit2529e0a; presentation source hashes below.

Invocation (cwd /home/gunp4ng/working/bubble_lock/web-dashboard):

```sh
TMPDIR=/tmp/tmp.2Az82XFb1p NODE_COMPILE_CACHE=/tmp/tmp.2Az82XFb1p/node-compile-cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/tmp.2Az82XFb1p/bun-transpiler npm test
# then, with the same environment:
npm run build
```

Background session bash_9 completed exit0. Tests21, pass21, fail0, cancelled0, skipped0, todo0. Duration440.58016ms. Build tsc --noEmit && vite build succeeded; Vite7.3.7,225 modules; assets index-_0qXgXN1.css9.64kB and index-CbaDgs3F.js415.90kB; built1.27s.

An earlier pass was21/21 and build exit0 before the enlarged-text correction; the final run above supersedes it. No tests, contracts, server or shared reducer files were modified. LSP was attempted but biome/typescript-language-server are unavailable; no diagnostics-clean claim is made. Required build runs the installed TypeScript compiler instead.

Source hashes:

```json
[
  {
    "path": "DESIGN.md",
    "sha256": "beb43a7e8fddcc129a375f0e0d54147b40139ca47cb1c66a3e41b886c5b4cceb"
  },
  {
    "path": "src/App.tsx",
    "sha256": "d74afbb2543988c8c8c698665056fc0dfddecee83b7b006eddc05ceb1c09798a"
  },
  {
    "path": "src/ui.tsx",
    "sha256": "38462fbb535207a156082b9e68436cda0e6f3189169c270ab0500ee1fa8d7fb6"
  },
  {
    "path": "src/Resources.tsx",
    "sha256": "8f3e2298c9188d35a04114f753432c3f9be22f8d699731dfaba6b9ef99d6721a"
  },
  {
    "path": "src/styles.css",
    "sha256": "641f8c85c041594ea896e8e1ab831ce3063689a631f5d1ce2503f7ff0370d512"
  },
  {
    "path": "src/useEventStream.ts",
    "sha256": "39009f63d55a11d550d3f7c3d0f827d6b4310f1cca093bfec783328974b99ff5"
  }
]
```
