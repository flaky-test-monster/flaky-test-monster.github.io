# Flakifier

Turn a webcam photo into a 3D-printable STL figure: the Flaky
Test Monster in one of three looks, a marble bust, or a LEGO-style minifigure. The app
itself is plain Node and vanilla JavaScript: no npm dependencies, no bundler, no
database. The models run in the cloud (OpenAI, Tripo3D) or, with the local pipeline,
entirely on your Mac.

Before clicking **Flakify**, pick **how to make it** (the 3D method, each explained in
plain words on the form) and then a **figure** (what the photo turns into). Methods that
cannot run here are greyed out with the reason, for example a missing API key or no server
on the GitHub Pages preview. The figure list depends on the method: the server methods offer
the figures below, the in-browser method offers its relief shapes.

Figures for the server methods, defined with their prompts in `lib/figures.js`:

- **Marble bust**
- **LEGO minifigure**
- **Flaky Test Monster** (default): a green monster figurine with your hair, glasses and beard
- **Monster LEGO minifigure** and **Monster Playmobil pirate:** the monster as a toy

The three monster prompts refer to the reference image in
`figures/flaky-test-monster.jpg`, which the OpenAI pipelines send along with the photo;
without it, the prompt's own description has to carry the look. The local pipeline
uses only the photo, because FLUX.1 Kontext takes a single image.

3D methods:

- **Tripo3D (default):** photo → OpenAI Images (figure PNG) → Tripo3D (image to 3D, GLB)
  → STL.
- **Simple shapes (OpenAI only):** photo → OpenAI Images (figure PNG) → GPT vision model
  (figure as a list of solid shapes, JSON) → local mesher (STL).
- **Local, on this Mac:** photo → FLUX.1 Kontext via mflux (figure PNG) → pixal3d.cpp
  `trellis-server` (image to 3D, GLB) → STL. No API keys, no cloud, no cost per run. See
  [Local pipeline](#local-pipeline-apple-silicon).

- **Free and private, in this browser:** photo → face landmarks, background removal and
  depth map → relief STL, with free open models that the browser downloads and runs itself.
  No API keys, no install and no GPU server; the photo never leaves the device. It makes a
  3D relief (a monster bobblehead, smooth, rounded or LEGO-style bricks) rather than a full
  statue. See
  [In-browser pipeline](#in-browser-pipeline).

The form lists them as *Best quality, in the cloud* (Tripo3D), *Chunky toy look, in the
cloud* (simple shapes), *Private, on the Flakifier Mac* (local) and *Free and private, in
this browser*, and picks the first one that can run. `GET /api/pipelines` tells the page
which server methods are set up.

OpenAI has no image-to-3D API, so with simple shapes the GPT model doesn't return a
mesh directly. It looks at the figure image and describes the figure as 20 to 100
simple solids: ellipsoids, boxes, cylinders or cones, and tori, with sizes and positions
in millimetres. `lib/mesh.js` turns those solids into triangles, centers the result on
the build plate and scales it to 100 mm tall. Expect a stylised toy look, not a sculpted
likeness.

## Requirements

- macOS (the install script) and Node 22 or newer, which the script installs
- For the local pipeline: an Apple Silicon Mac, ideally with 32 GB of memory, and about
  50 GB of free disk space
- An OpenAI API key with access to `gpt-image-1` and, for the simple-shapes method, a vision
  model that supports structured outputs (default `gpt-5`)
- A Tripo3D API key for the Tripo3D method

## Get the API keys

**OpenAI.** Sign in at <https://platform.openai.com/>, open *API keys* and create a new
secret key. Usage is billed, so add a small amount of credit to the account first. The
key starts with `sk-`.

**Tripo3D.** Sign in at <https://platform.tripo3d.ai/>, open *API keys* and create a key.
It starts with `tsk_`. New accounts get some free credits; image-to-3D runs cost credits
per model.

## Install

```sh
scripts/install.sh              # everything, including the local pipeline
scripts/install.sh --cloud-only # just Node, for the OpenAI and Tripo3D pipelines
```

The installer is macOS only and safe to re-run; finished steps are skipped. It installs
the Xcode command line tools and Homebrew if they are missing, Node 22+, and, unless you
pass `--cloud-only`, everything the [local pipeline](#local-pipeline-apple-silicon)
needs. The full install downloads about 45 GB and pauses twice for you: to paste a
Hugging Face token, and to accept the FLUX.1 Kontext licence in the browser.

For the cloud pipelines, add your keys:

```sh
cp .env.example .env
```

Edit `.env` and paste the keys:

```
OPENAI_API_KEY=sk-...
TRIPO_API_KEY=tsk_...
```

The server always starts and logs which pipelines are unavailable and why: without
`TRIPO_API_KEY` the Tripo3D method is off, and without any `.env` only the local
pipeline can run. Optional overrides: `OPENAI_IMAGE_MODEL`
(default `gpt-image-1`), `OPENAI_MODEL` (default `gpt-5`), `TARGET_HEIGHT_MM` (simple-shapes
figure height, default `100`) and `PORT` (default `3000`, read from the shell).

The keys are read on the server with `process.loadEnvFile()` and never sent to the
browser. `.env` and the `jobs/` folder are gitignored.

## Run

```sh
scripts/start.sh
```

This starts the local 3D server in the background when the local pipeline is installed
(log in `logs/trellis-server.log`), waits until it is ready, then starts Flakifier. Ctrl-C
stops both. A 3D server you already started yourself is reused and left running.
`node server.js` still works when you only use the cloud pipelines.

Open <http://localhost:3000>. Take a photo, choose how to make it and a figure, and click
**Flakify**. The stepper lights up as each stage finishes, the styled image
appears as soon as it is ready, and the final screen shows the model in a rotating 3D
viewer with download buttons for the STL, the styled image and the original photo, plus
the GLB from Tripo3D or the local pipeline.

Every run writes its files to `jobs/<uuid>/`: `pipeline.txt`, `figure.txt`, `name.txt`
(when named), `input.png` or `input.jpg`, then `figure.png`, then `model.glb` (Tripo3D
and local) or `model.json` (simple shapes, the shape list the model returned), then
`model.stl`, and `error.txt` if something went wrong. Older runs have `statue.png` or
`lego.png` instead of `figure.png` and still open. Past runs are listed on the start
screen, where you can reopen or delete them.

## Monster scan

The monster scan is always on while the camera is: it tracks your face in the live webcam
video and keeps a **monster score** from 0 (human) to 100 (Flaky Test Monster). Nothing is
uploaded and no API key is needed.

The score is all in the mouth: closed is 0, wide open is 100. Up to four faces are
tracked at once, each with its own score; the preview shows the highest. Openness is the gap between the lips
over the width of the mouth, so it does not matter how close you sit to the camera (see
`public/js/monster-score.js`). Below 40 is human, 60 and up is a monster, in between is
suspicious. Each frame is blended with the previous score so the score does not jitter.
The score sits over the camera preview, as a compact badge in the page and larger in full
screen (with how many faces in view are monsters). A checkbox next to the verdict stays
unchecked while you are human and is checked once you are a monster, and a polite
instruction says what to do: look into the camera, then open your eyes and mouth wide like
the monster. Screen readers hear the verdict and the monster count from the status line under the
camera.

As the score climbs the preview turns into a high-contrast poster. Once you are a monster
it goes green, and every monster face gets white eyes with small black pupils and a red
tongue in its open mouth. **Take photo** keeps what the preview shows: the photo it hands
to the 3D methods has the poster look at the strength the score has reached, and the green,
eyes and tongue if you are a monster. Keep your mouth closed for a plain photo.

When the score hits 100 the scan takes a **monster photo** of the preview, effects and
all, with a white flash and a shutter click. While the score stays at 100 it takes another
every 5 seconds. The last 6 show as small thumbnails to the right of the video (below it
on a phone, over it in full screen). Click one to see it in place of the video, with
**Back to camera** (or Escape), **Download**, and **Save to recent runs**, which keeps it
as a "Monster photo" run that holds only the photo and costs nothing; open that run to
flakify the photo. New photos keep coming in as thumbnails without taking over the view. Saving goes through `POST /api/photos`.

Faces are tracked by [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
(`public/js/monster-face.js`), loaded from jsDelivr with its model from Google's storage when
the camera first starts (a few MB, then cached by the browser). The shutter click plays
from the first click or tap on the page on, since browsers keep pages silent until then.

## Local pipeline (Apple Silicon)

Runs the whole pipeline on your Mac with two open models, for every figure preset. Tested
hardware for the underlying projects is Apple Silicon with 24 to 32 GB of unified memory;
on 32 GB, run nothing else heavy alongside. The two steps run one after the other, so their memory
needs don't add up.

| Step | Model | Licence |
|---|---|---|
| Figure image | [FLUX.1 Kontext \[dev\]](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev) via [mflux](https://github.com/filipstrand/mflux) | FLUX.1 \[dev\] Non-Commercial: personal use is fine, commercial use needs a licence from Black Forest Labs |
| LEGO style (LEGO figures only) | [Kontext-Style/LEGO_lora](https://huggingface.co/Kontext-Style/LEGO_lora), a LoRA for FLUX.1 Kontext | Check the model page; as a FLUX.1 \[dev\] add-on it is non-commercial at most |
| Image to 3D | TRELLIS.2 via [pixal3d.cpp](https://github.com/LighthausInc/pixal3d.cpp) | MIT (code and TRELLIS.2 weights); the DINOv3 encoder is under Meta's DINOv3 licence |

Neither is restricted to particular regions. Hunyuan3D was not chosen because its
licence excludes the EU, UK and South Korea.

### What `scripts/install.sh` sets up

- **uv, CMake and Ninja** from Homebrew.
- **mflux** with `uv tool install mflux`, which puts `mflux-generate-kontext` in
  `~/.local/bin`. `scripts/start.sh` adds that folder to `PATH`; if you start
  Flakifier another way, set `MFLUX_COMMAND` to the full path.
- **pixal3d.cpp**, cloned into `vendor/pixal3d.cpp` and built with Metal.
- **TRELLIS.2 weights**, the 8-bit GGUF set (about 11 GB) from
  [`ilintar/trellis2-gguf`](https://huggingface.co/ilintar/trellis2-gguf), into
  `models/trellis2/q8`.
- **FLUX.1 Kontext weights** (about 34 GB), cached by running one tiny edit, so the first
  bust doesn't stall on the download. The model is gated, so the installer asks you to
  accept its licence on Hugging Face first.
- **LEGO style LoRA** (about 360 MB), cached the same way. If it fails to load, the
  installer says so and carries on.

`vendor/`, `models/` and `logs/` are gitignored. Delete them and
`~/.cache/huggingface` to reclaim the space.

### Tuning

- `LOCAL_FAST=1` (or `scripts/start.sh --fast`) renders the statue image at 512×512 with
  8 steps instead of 1024×1024 with 20, roughly 10x less work, for testing the pipeline.
  The result is rougher.
- **LEGO figures** (*LEGO minifigure* and *Monster LEGO minifigure*) run FLUX.1 Kontext with
  the [LEGO style LoRA](https://huggingface.co/Kontext-Style/LEGO_lora), and their prompt
  starts with its trigger sentence, "Turn this image into the LEGO style." mflux downloads
  the LoRA on first use if the installer didn't. `LOCAL_LORAS=0` turns it off; those
  figures then use their plain prompt.
- `MFLUX_QUANTIZE` (default `8`) can be lowered to `4` to save memory at some cost in
  quality.
- `LOCAL_3D_RESOLUTION` (default `512`) can be `1024` or `1536` for more detail and
  longer runs.
- `LOCAL_3D_URL` (default `http://127.0.0.1:8080`) moves the 3D server; `scripts/start.sh`
  starts it on that address.
- The 3D server runs with `--no-texture`: a print only needs the shape, and skipping the
  texture bake saves several minutes.

### Use it

Pick **Local, on this Mac** as the 3D model method. If the 3D server isn't reachable or the mflux
command isn't found, Flakifier says so as soon as you click **Flakify**. Expect roughly
10 to 20 minutes per figure: 1 to 2 minutes for the image and the rest for the 3D model.
These times are estimates from the projects' published benchmarks, not measured with
Flakifier.

## In-browser pipeline

Pick **Free and private, in this browser** on the form. Everything runs in a Web Worker in
the page (`public/js/browser-worker.js`); the server only hands out the files, so this method
also works on the [GitHub Pages build](#github-pages-and-pr-previews), which has no server.
The progress steps read Models, Cut-out, Depth and STL, and the result shows the cut-out in
place of the figure image, with the depth map as an extra download.

| Step | Model | Licence | Download |
|---|---|---|---|
| Background removal | [MODNet](https://huggingface.co/Xenova/modnet) (ONNX) | Apache-2.0 | about 25 MB |
| Depth estimation | [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) (ONNX) | Apache-2.0 | about 100 MB |
| Face landmarks | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker), the monster scan's | Apache-2.0 | about 4 MB |
| Face depth, caricature, monster parts | `public/js/caricature.js`, no model | MIT (this repo) | none |
| Relief mesh and STL | `public/js/relief.js`, no model | MIT (this repo) | none |

The face landmarks are found on the page, since MediaPipe needs WebGL, and sent to the worker
with the photo. They are optional: without a face, or if the tracker cannot load, the figure
is made without the face touches below.

Both Transformers.js models run with [Transformers.js](https://github.com/huggingface/transformers.js)
3.8.1, loaded from the jsDelivr CDN. They are fetched from the Hugging Face Hub on the
first run (the page shows download progress) and kept in the browser's cache, so later
runs work without downloading again. WebGPU is used when the browser offers it (current
Chrome and Edge); otherwise the models run on the CPU through WebAssembly, which is slower
but works everywhere.

How the smooth STL is built: the cut-out's outline becomes a grid of square cells, 160
across the subject. Each cell gets a front face raised
by the depth map plus a dome that rounds the outline, a back face, and side walls along the
outline, so the mesh is closed and watertight. Only the largest connected piece of the
subject is kept, small gaps inside it (often in hair) are filled, and the outline is
smoothed so it does not show the grid's stair steps. Depth models make faces nearly flat,
so when a face is found its landmarks' own depth is blended in, which brings out the nose
and chin. The model is 100 mm tall, stands upright (Z up) and faces the front.

- **Monster bobblehead** (default): a relief with a flat back, warped into a caricature
  first. The head is 1.5 times bigger, and the eyes, nose and mouth are enlarged on top.
  Then the monster parts are added as separate solids sunk into the front: googly eyes
  with pupils looking two different ways, a tongue hanging over the chin (longer the wider
  the mouth is open), two fangs and two horns on the hair. The warp and the parts come
  from `public/js/caricature.js`. Without a face in the photo it is a plain relief.
- **Relief with a flat back:** about 3 to 17 mm thick. Lay it on its back in the slicer
  and it prints without supports.
- **Rounded on both sides:** also domed at the back, for a free-standing piece. A photo
  cropped at the shoulders gives it a flat bottom to stand on.
- **LEGO-style bricks:** the same relief built from bricks. Each grid point inside the
  outline becomes a stud-wide column, as thick as the relief there rounded to whole plates
  (LEGO proportions: a plate is 0.4 of the stud pitch), with a stud on its front, 32 studs
  across the subject. Flat back, so it prints lying down with the
  studs up. The columns form one closed mesh; each stud is its own closed shell sunk
  slightly into its column, which slicers merge when slicing. It is a printed look-alike,
  not a buildable LEGO set.

Results stay in the page: they are not listed under recent runs and are gone after a
reload or **Start over**, so download what you want to keep. Depth from a single photo is an estimate:
faces come out recognisable but flattened, and the back of a rounded figure is invented.

## GitHub Pages and PR previews

The frontend is published as a static site on GitHub Pages, so changes to the UI can be
tried without installing anything. Pages has no backend, so the build marks the page with
`data-backend="none"` and the app runs browser-only: the camera and the
[monster scan](#monster-scan) work, a taken photo can be downloaded, and a notice says
that the rest needs the Node server (`npm start`). Flakify works with the
[in-browser method](#in-browser-pipeline); the server methods are greyed out on the form,
saving scan photos is disabled and the recent runs are hidden.

- `.github/workflows/pages.yml` deploys `main` to the `gh-pages` branch.
- `.github/workflows/pr-preview.yml` deploys each pull request to
  `pr-preview/pr-<number>/` on the same branch, comments the preview URL on the PR, and
  removes the preview when the PR is closed. PRs from forks get no preview, because
  their token cannot push.
- `scripts/build-pages.sh` builds the site into `_site/`, minifying the JS and CSS with
  esbuild and the HTML with html-minifier-terser. Both are pinned and fetched by `npx`,
  so the app still has no npm dependencies; the Node server serves `public/` unminified.

One-time setup: in the repository's **Settings → Pages**, set **Source** to
**Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. The branch is created by
the first deploy.

## Music page vote and scoreboard

The music page (`public/music.html`) lets visitors give the songs Eurovision points (12, 10,
8 and down to 1, each score to one song only). With a [Supabase](https://supabase.com)
project the votes are cast online and a scoreboard shows the totals, updating every 30
seconds and right after a vote. Without one, the votes go out by email as before and the
scoreboard stays hidden.

How it stays safe, with only a static page and the public anon key in the browser:

- **One ballot per voter.** Voters sign in anonymously with Supabase Auth, only when they
  cast their first votes. Casting again replaces the ballot, and the browser keeps the
  session, so a returning jury sees its own votes.
- **No direct table access.** Row level security is on and anon and authenticated have no
  rights on the tables. The page can only call three functions:
  `cast_ballot` checks every vote in the database (known songs, valid points, each score
  once, a jury name of at most 60 characters, voting open, at most one change every 5
  seconds), `my_ballot` returns the caller's own ballot only, and `scoreboard` returns the
  totals only: never who gave what, and never the typed-in jury names.
- **The voter's country, from the connection.** Each ballot keeps the two-letter country
  Cloudflare, in front of Supabase, names for the caller (the `CF-IPCountry` header),
  never the IP address. The scoreboard shows only how many countries voted. The page says
  so next to the vote button. It is a best guess: a VPN changes it, and a ballot whose
  country is unknown (or comes through Tor) is kept without one. Whether Supabase passes
  the header on to the database is not documented, so check after the first votes:
  `select country, count(*) from public.ballots group by country;` If every row is
  empty, the header does not arrive and the count stays hidden.
- **Limits on new voters.** Supabase rate-limits anonymous sign-ins per IP address, and a
  Cloudflare Turnstile captcha can be required on top. Someone who clears their browser
  can still vote again; that is the trade-off of voting without an account.

Setup:

1. Create a Supabase project. In **Authentication → Sign In / Providers**, turn on
   **Allow anonymous sign-ins**. Use a project of its own for the vote: anonymous sign-ins
   are for the whole project, and anonymous users get the `authenticated` role, so any
   existing policy written `to authenticated` would let any visitor in. If you share a
   project, check those policies for `(auth.jwt() ->> 'is_anonymous')::boolean`.
   Supabase limits new anonymous users to 30 an hour per IP address by default. If many
   juries vote from one network, such as a party's Wi-Fi, raise it under
   **Authentication → Rate Limits**.
2. Run `supabase/migrations/20261011000000_music_votes.sql` in the SQL editor (or
   `supabase db push`). It can be run again; it upserts the songs. A song's id is the
   `data-song` attribute of its list item on the music page, so add new songs to both.
3. Give the page the project URL and the anon (publishable) key from **Project Settings →
   API**. For GitHub Pages, set them as repository variables (**Settings → Secrets and
   variables → Actions → Variables**) named `SUPABASE_URL` and `SUPABASE_ANON_KEY`; the
   build writes them into the page's meta tags. For `npm start`, fill in the
   `flaky-supabase-*` meta tags in `public/music.html`. Both values are public by design.
4. Recommended: add a captcha. Create a Cloudflare Turnstile widget, enter its secret key
   in Supabase under **Authentication → Attack Protection**, and set its site key as the
   variable `TURNSTILE_SITE_KEY` (or the `flaky-captcha-sitekey` meta tag).

To close voting: `update public.contest set open = false;` (and `true` to open it again).
The scoreboard keeps showing the final totals.

## Notes

- **Webcam access only works on `localhost` or over HTTPS.** Browsers block
  `getUserMedia` on plain `http://` for any other host. If camera permission is denied
  or there is no camera, the camera card says so and its buttons are disabled; allow the
  camera and reload.
- **Run time is about 1 to 4 minutes.** The OpenAI image edit takes 20 to 60 seconds.
  The Tripo3D method then spends 1 to 2 minutes in Tripo3D plus a short STL export; the
  server polls Tripo3D every 3 seconds and gives up after 10 minutes. The simple-shapes
  method spends 30 seconds to 3 minutes generating the shape list, depending on the model.
- **Approximate cost per run.** Roughly $0.10 to $0.30 for the OpenAI image edit
  (1024×1024, high input fidelity). The Tripo3D method adds roughly 20 to 30 Tripo3D
  credits for the model plus the STL conversion, in the region of $0.30 to $0.60 on paid
  plans. The simple-shapes method adds a few cents for the shape generation. Check the
  providers' current pricing pages for exact numbers.
- The local pipeline, and the Tripo3D method when Tripo3D's STL export is unavailable,
  use the built-in GLB→STL converter (`lib/stl.js`). It reads the mesh positions and
  indices, turns the Y-up glTF model upright for Z-up slicers, and writes a binary STL.
  The mesh is not repaired or checked for watertightness.
- **Printing a simple-shapes figure.** Each solid is its own closed, outward-facing shell, and
  the solids overlap. Slicers such as PrusaSlicer, Cura and Bambu Studio merge
  overlapping shells when slicing. If a tool needs one manifold mesh, run a boolean
  union or "repair" first. Add supports under the arms if your slicer asks for them.
- The 3D viewer loads Three.js from the jsDelivr CDN through an import map, so the result
  page needs internet access. The in-browser pipeline also loads Transformers.js from
  jsDelivr and its models from Hugging Face. Everything else is served locally.
- The printed model is only as good as the photo: face the camera, use even lighting and
  keep the background plain.
