# AGENTS.md

Guidance for coding agents working on Flakifier. Read `README.md` for what the app does
and how it is used; this file covers how the code is laid out and how to change it safely.

## What this is

Flakifier turns a webcam photo into a 3D-printable STL figure (Flaky Test Monster, marble
bust, LEGO-style minifigure, ...). A plain Node server (`server.js`) serves a vanilla JS
frontend (`public/`) and runs the server-side pipelines; an in-browser pipeline and the
monster scan run entirely client-side. `public/music.html` is a separate music page with no
backend of its own; its jury vote and scoreboard can optionally run on a Supabase project
(`supabase/migrations/`), called straight from the browser.

## Hard rules

- **No npm dependencies, no bundler, no framework, no database.** `package.json` has no
  `dependencies` and must stay that way. Use Node built-ins (`node:http`, `node:fs/promises`,
  `node:crypto`, ...) and browser APIs. The only exceptions:
  - Browser libraries loaded from jsDelivr by URL with a pinned version (Three.js via the
    import map in `public/flakifier.html`, Transformers.js in `public/js/browser-worker.js`).
  - Build tools pinned in `scripts/build-pages.sh` and fetched by `npx` at build time.
  - The music page's optional online vote: supabase-js from jsDelivr, pinned, in
    `public/js/music-online.js`, against a Supabase project. Its schema lives in
    `supabase/migrations/`; the tables are closed to the browser and reached only through
    the functions there, which check every input. Keep it that way, and keep the email
    vote working when no project is configured.
  - GoatCounter page-view counting (`gc.zgo.at/count.js`) on `flakifier.html`, `music.html` and `about.html`.
    It is optional by nature: nothing may depend on it loading.
- **Node 22+, ES modules only** (`"type": "module"`). Use `import.meta.dirname`, top-level
  `await`, `process.loadEnvFile()`; no CommonJS.
- **API keys stay on the server.** They are read from `.env` and never sent to the browser
  or written to job files or logs. Never commit `.env`, `jobs/`, `logs/`, `models/`,
  `vendor/` or `_site/`.
- **Every server method must degrade gracefully.** A missing key or missing local install
  disables that method with a human-readable reason (see `API_KEY_SERVICES` and
  `localUnavailableReason`); the server must still start.
- **The frontend must work on GitHub Pages**, where there is no backend
  (`data-backend="none"` on `<html>`). Anything that calls `/api/...` must check for that
  and disable itself with a clear notice instead of failing.

## Layout

```
server.js               HTTP server: routing table, static files, /api endpoints, job runner
lib/
  figures.js            figure presets: prompts, local prompts/LoRAs, reference images
  openai.js             OpenAI image edit (figure PNG) and shape-list generation (JSON)
  tripo.js              Tripo3D image → GLB/STL, polling
  local.js              local pipeline: mflux (FLUX.1 Kontext) + pixal3d.cpp trellis-server
  mesh.js               shape list → STL (simple-shapes method)
  stl.js                GLB → binary STL converter
  jobs.js               jobs/<uuid>/ storage; the only module-level state on the server
public/
  flakifier.html        main app page (import map for Three.js lives here)
  music.html            music page, also the start page (/); optional Supabase vote (meta tags)
  music-admin.html      admin page of the vote: sign in, list, add and delete ballots
  about.html            about page: the monster's story, a timeline with photos (media/about/)
  spooky.html           Halloween story for Syntax: lost Flash source → music, flaky tests → music
  css/                  header.css (the header all pages share), style.css (app), music.css
                        (music page), about.css (about page),
                        spooky.css (spooky story)
  js/                   ES modules, imported with relative './x.js' paths
    app.js              main UI controller
    browser-worker.js   in-browser pipeline worker (Transformers.js models)
    relief.js           mask + depth → watertight relief STL; runs in browser and Node (no DOM)
    caricature.js       face warp and monster parts for the relief
    monster-*.js        live face tracking and the monster score
    music-*.js          music page modules
    viewer.js, zip.js   3D viewer, tiny zip writer
  media/                videos, songs, photos (copied as is into the Pages build)
supabase/migrations/    music vote schema: tables, RLS, cast_ballot / my_ballot / scoreboard,
                        and the admin_* functions, open to the users in public.admins only
figures/                reference images for figure presets (see figures/README.md)
scripts/
  install.sh            macOS installer (Node, plus local pipeline unless --cloud-only)
  start.sh              starts trellis-server (if installed) and the Node server
  build-pages.sh        builds the static site into _site/ for GitHub Pages
.github/workflows/      pages.yml (deploy main), pr-preview.yml (per-PR previews)
```

## Running and checking changes

```sh
node server.js          # cloud pipelines only; http://localhost:3000
scripts/start.sh        # also starts the local 3D server when installed (--fast for quick tests)
scripts/build-pages.sh  # static build into _site/, as GitHub Pages will serve it
```

There is no test suite and no linter config. To check a change:

- `node --check <file>.js` for syntax on any changed JS file.
- Start the server and load the page; watch the server log and the browser console.
- For frontend changes, also run `scripts/build-pages.sh` and serve `_site/` (for example
  `npx --yes serve _site`) to confirm the backend-free build still works. The build script
  ends with `grep -q` sanity checks; keep them passing.
- Pure modules such as `lib/mesh.js`, `lib/stl.js` and `public/js/relief.js` can be
  exercised directly from a small `node -e` / `node --input-type=module` script.
- Full pipeline runs cost money (OpenAI, Tripo3D) or take minutes (local). Don't trigger
  them without the user's go-ahead.

## Conventions

- **Style:** 2-space indent, single quotes, semicolons, `const` by default. Named
  `UPPER_SNAKE_CASE` constants at the top of a module instead of magic numbers.
- **Comments:** each module starts with a short comment saying what it does; exported
  functions and non-obvious constants get JSDoc (`/** ... */`, with `@param` types).
  Comments explain *why*, in plain sentences.
- **Errors:** server handlers throw `HttpError(status, message)`; messages are short,
  user-facing and say what to do. Failed jobs write `error.txt`.
- **Frontend modules** import each other with relative paths (`./monster-face.js`). Pages
  link assets relatively (`public/js/...`, `public/css/...`) because GitHub Pages serves
  the site under a sub-path. Don't introduce absolute `/public/...` URLs.
- **CSS:** shared values are custom properties (tokens); reuse them rather than adding
  near-duplicate colors or sizes. Keep it accessible: semantic HTML, visible focus,
  readable in high contrast.
- **Job files** follow the fixed names in `lib/jobs.js` (`JOB_FILE_PATTERN`). If you add a
  file type, update that pattern and keep older job folders readable.
- **Backwards compatibility:** old pipeline names (`LEGACY_PIPELINES`) and old image names
  (`statue.png`, `lego.png`) are still accepted; don't drop them.

## When you change things, also update

- **`README.md`** whenever user-visible behavior, setup, env vars, methods, figures or
  costs change. It is the user documentation and is kept accurate.
- **`.env.example`** when adding or renaming an environment variable.
- **`scripts/build-pages.sh`** when adding, moving or renaming files under `public/`: it
  copies media, minifies `public/js/*.js` and `public/css/*.css`, and rewrites asset links
  with a `?v=<commit>` cache buster. New HTML pages need their own build line, and the
  `sed` that versions links must still match the new paths.
- **`STATIC_TYPES` in `server.js`** when serving a new file extension.
- **`lib/figures.js`** (and `figures/` + `figures/README.md` for reference images) when
  adding a figure preset.

## Commits and PRs

- Small, focused commits with a short, descriptive subject (for example
  `Music page: ...` or `fix: ...`).
- Every PR from a branch in this repo gets a preview on GitHub Pages under
  `pr-preview/pr-<number>/`; check it for frontend changes.
