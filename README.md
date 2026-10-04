# Flakifier

Turn a webcam photo or an uploaded portrait into a 3D-printable STL, either as a
classical marble bust or as a LEGO-style minifigure. Runs entirely on your machine with
plain Node and vanilla JavaScript: no npm dependencies, no bundler, no database.

Pick the style from the **Style** dropdown before clicking **Flakify**:

- **Marble bust (default):** photo → OpenAI Images (marble bust PNG) → Tripo3D (image to
  3D, GLB) → STL.
- **LEGO minifigure (ChatGPT only):** photo → OpenAI Images (LEGO minifigure PNG) → GPT
  vision model (figure as a list of solid shapes, JSON) → local mesher (STL).

OpenAI has no image-to-3D API, so in the LEGO pipeline the GPT model doesn't return a
mesh directly. It looks at the minifigure image and describes the figure as 20 to 100
simple solids: ellipsoids, boxes, cylinders or cones, and tori, with sizes and positions
in millimetres. `lib/mesh.js` turns those solids into triangles, centers the result on
the build plate and scales it to 100 mm tall. Expect a stylised toy look, not a sculpted
likeness.

## Requirements

- Node 22 or newer (`node --version`)
- An OpenAI API key with access to `gpt-image-1` and, for the LEGO pipeline, a vision
  model that supports structured outputs (default `gpt-5`)
- A Tripo3D API key for the marble bust pipeline

## Get the API keys

**OpenAI.** Sign in at <https://platform.openai.com/>, open *API keys* and create a new
secret key. Usage is billed, so add a small amount of credit to the account first. The
key starts with `sk-`.

**Tripo3D.** Sign in at <https://platform.tripo3d.ai/>, open *API keys* and create a key.
It starts with `tsk_`. New accounts get some free credits; image-to-3D runs cost credits
per model.

## Set up

```sh
cp .env.example .env
```

Edit `.env` and paste the keys:

```
OPENAI_API_KEY=sk-...
TRIPO_API_KEY=tsk_...
```

Without `TRIPO_API_KEY` the server still starts, logs that the marble pipeline is
disabled, and only the LEGO pipeline works. Optional overrides: `OPENAI_IMAGE_MODEL`
(default `gpt-image-1`), `OPENAI_MODEL` (default `gpt-5`), `TARGET_HEIGHT_MM` (LEGO
figure height, default `100`) and `PORT` (default `3000`, read from the shell).

The keys are read on the server with `process.loadEnvFile()` and never sent to the
browser. `.env` and the `jobs/` folder are gitignored.

## Run

```sh
node server.js
```

Open <http://localhost:3000>. Take a photo or drop a PNG/JPG (max 10 MB), choose a style,
and click **Flakify**. The stepper lights up as each stage finishes, the styled image
appears as soon as it is ready, and the final screen shows the model in a rotating 3D
viewer with download buttons for the STL, the styled image and the original photo, plus
the GLB for the marble bust.

Every run writes its files to `jobs/<uuid>/`: `pipeline.txt`, `input.png` or `input.jpg`,
then `statue.png` and `model.glb` (marble) or `lego.png` and `model.json` (LEGO, the
shape list the model returned), then `model.stl`, and `error.txt` if something went
wrong. Delete the folder whenever you like.

## Notes

- **Webcam access only works on `localhost` or over HTTPS.** Browsers block
  `getUserMedia` on plain `http://` for any other host. If camera permission is denied,
  the camera card is hidden and you can still upload an image.
- **Run time is about 1 to 4 minutes.** The OpenAI image edit takes 20 to 60 seconds.
  The marble pipeline then spends 1 to 2 minutes in Tripo3D plus a short STL export; the
  server polls Tripo3D every 3 seconds and gives up after 10 minutes. The LEGO pipeline
  spends 30 seconds to 3 minutes generating the shape list, depending on the model.
- **Approximate cost per run.** Roughly $0.10 to $0.30 for the OpenAI image edit
  (1024×1024, high input fidelity). The marble pipeline adds roughly 20 to 30 Tripo3D
  credits for the model plus the STL conversion, in the region of $0.30 to $0.60 on paid
  plans. The LEGO pipeline adds a few cents for the shape generation. Check the
  providers' current pricing pages for exact numbers.
- If Tripo3D's STL export is unavailable, the server falls back to a built-in GLB→STL
  converter (`lib/stl.js`) that reads the mesh positions and indices and writes a
  binary STL. The mesh is not repaired or checked for watertightness.
- **Printing the LEGO figure.** Each solid is its own closed, outward-facing shell, and
  the solids overlap. Slicers such as PrusaSlicer, Cura and Bambu Studio merge
  overlapping shells when slicing. If a tool needs one manifold mesh, run a boolean
  union or "repair" first. Add supports under the arms if your slicer asks for them.
- The 3D viewer loads Three.js from the jsDelivr CDN through an import map, so the result
  page needs internet access. Everything else is served locally.
- The printed model is only as good as the photo: face the camera, use even lighting and
  keep the background plain.
