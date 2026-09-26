# Flakifier

Turn a webcam photo or an uploaded portrait into a classical marble bust, then into a
3D-printable STL. Runs entirely on your machine with plain Node and vanilla JavaScript:
no npm dependencies, no bundler, no database.

Pipeline: photo → OpenAI Images (marble bust PNG) → Tripo3D (image to 3D, GLB) → STL.

## Requirements

- Node 22 or newer (`node --version`)
- An OpenAI API key with access to the `gpt-image-1` model
- A Tripo3D API key

## Get the API keys

**OpenAI.** Sign in at <https://platform.openai.com/>, open *API keys* and create a new
secret key. Image generation is billed per image, so add a small amount of credit to the
account first. The key starts with `sk-`.

**Tripo3D.** Sign in at <https://platform.tripo3d.ai/>, open *API keys* and create a key.
It starts with `tsk_`. New accounts get some free credits; image-to-3D runs cost credits
per model.

## Set up

```sh
cp .env.example .env
```

Edit `.env` and paste both keys:

```
OPENAI_API_KEY=sk-...
TRIPO_API_KEY=tsk_...
```

The keys are read on the server with `process.loadEnvFile()` and never sent to the
browser. `.env` and the `jobs/` folder are gitignored.

## Run

```sh
node server.js
```

Open <http://localhost:3000>. Take a photo or drop a PNG/JPG (max 10 MB), confirm it and
click **Flakify**. The stepper lights up as each stage finishes, the statue image appears
as soon as it is ready, and the final screen shows the model in a rotating 3D viewer with
download buttons for the STL, the GLB, the statue image and the original photo.

Every run writes its files to `jobs/<uuid>/`: `input.png` or `input.jpg`, `statue.png`,
`model.glb`, `model.stl`, and `error.txt` if something went wrong. Delete the folder
whenever you like.

## Notes

- **Webcam access only works on `localhost` or over HTTPS.** Browsers block
  `getUserMedia` on plain `http://` for any other host. If camera permission is denied,
  the camera card is hidden and you can still upload an image.
- **Run time is about 1 to 3 minutes.** The OpenAI image edit takes 20 to 60 seconds and
  the Tripo3D image-to-3D task another 1 to 2 minutes, plus a short STL export. The
  server polls Tripo3D every 3 seconds and gives up after 10 minutes.
- **Approximate cost per run.** Roughly $0.10 to $0.30 for the OpenAI image edit
  (1024×1024, high input fidelity) and roughly 20 to 30 Tripo3D credits for the model
  plus the STL conversion, which is in the region of $0.30 to $0.60 on paid plans. Expect
  well under $1 per bust; check both providers' current pricing pages for exact numbers.
- The 3D viewer loads Three.js from the jsDelivr CDN through an import map, so the result
  page needs internet access. Everything else is served locally.
- If Tripo3D's STL export is unavailable, the server falls back to a built-in GLB→STL
  converter (`lib/stl.js`) that reads the mesh positions and indices and writes a
  binary STL. The mesh is not repaired or checked for watertightness.
- The printed bust is only as good as the photo: face the camera, use even lighting and
  keep the background plain.
