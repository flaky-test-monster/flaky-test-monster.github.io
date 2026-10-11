/**
 * The jury photo on the music page: a selfie from the webcam with a light overlay, the Flaky
 * sign on the right and the name of the jury at the bottom, to download as a PNG. The monster
 * filter of the start page is always on while a face is in view: the green poster look, and the
 * monster's eyes and tongue on every face. Everything is drawn on a canvas in this page; the
 * photo never leaves the device, unless it goes with the votes (music-vote.js).
 */

import { drawFaces, loadFaceTracker, posterize } from './monster-face.js';

const $ = (id) => document.getElementById(id);
const canvas = $('photo-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: !('filter' in CanvasRenderingContext2D.prototype) });
const video = $('photo-video');
const W = canvas.width;
const H = canvas.height;
const COUNTDOWN_SECONDS = 3;
/** The space kept free along the edges of the picture. */
const MARGIN = 56;
/** The start page's monster look at full strength, as in style.css and monster-face.js. */
const POSTER_FILTER = 'grayscale(1) contrast(7) brightness(1.15)';
const MONSTER_GREEN = 'rgb(47 209 47)';
/** How long the filter stays on after the face is lost, so a face the tracker misses for a
    few frames does not make the picture flicker. */
const LOOK_HOLD_MS = 500;
const DISPLAY = "'Bodoni MT', Didot, 'Times New Roman', serif";
const UTILITY = "'Courier New', monospace";

const monster = new Image();
monster.src = 'public/monster.jpg';
monster.addEventListener('load', () => draw());

/** @type {MediaStream | null} */
let stream = null;
/** The picture taken, as the raw camera frame, or null while the camera is live. */
let still = null;
let frameRequest = 0;
let busy = false;
/** The face tracker, once loaded; until then, or when it fails, the camera stays plain. */
let tracker = null;
let lastVideoTime = -1;
/** When the last face was in view. */
let faceSeenAt = -Infinity;
/** The monster's eyes and tongue for the live camera, at the video's own size. */
const eyes = document.createElement('canvas');
/** The eyes and tongue of the picture taken, or null when there was no face in it. */
let stillEyes = null;
/** The finished picture as a PNG file, made ahead of time: sharing it must start right on the
 * click, and the browser forgets the click while the canvas is still being encoded. */
let photoFile = null;

/** The name of the jury, shared with the vote: whoever votes is in the picture. */
const juryName = () => $('photo-jury').value.replace(/\s+/g, ' ').trim();

/** The largest font, up to size, at which text fits in maxWidth. */
function fit(text, maxWidth, size, font) {
  for (; size > 12; size -= 2) {
    ctx.font = `${font.replace('{size}', size)}`;
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  return size;
}

/** Draws the source cropped to fill the box, mirrored like a mirror, as the camera preview is. */
function cover(source, sourceWidth, sourceHeight, { x, y, w, h }) {
  const scale = Math.max(w / sourceWidth, h / sourceHeight);
  const sw = w / scale;
  const sh = h / scale;
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(source, (sourceWidth - sw) / 2, (sourceHeight - sh) / 2, sw, sh, 0, 0, w, h);
  ctx.restore();
}

/**
 * The camera picture across the whole canvas, or a dark space waiting for it. With faces, it
 * gets the monster look: the stark poster, the green over it, and the eyes and tongue on top.
 * @param {HTMLCanvasElement | null} [faces] the eyes and tongue, at the size of the source
 */
function photo(source, width, height, faces = null) {
  const all = { x: 0, y: 0, w: W, h: H };
  if (source && !faces) return cover(source, width, height, all);
  if (source) {
    if ('filter' in ctx) {
      ctx.filter = POSTER_FILTER;
      cover(source, width, height, all);
      ctx.filter = 'none';
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = MONSTER_GREEN;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } else {
      // No canvas filters in this browser: the same look, pixel by pixel.
      cover(source, width, height, all);
      posterize(ctx, W, H, { strength: 1, green: true });
    }
    if (faces.width && faces.height) cover(faces, faces.width, faces.height, all);
    return;
  }
  ctx.fillStyle = '#17130e';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(255 248 237 / .7)';
  ctx.textAlign = 'center';
  ctx.font = `italic 700 56px ${DISPLAY}`;
  ctx.fillText('Your face here', W / 2, H / 2 - 60);
  ctx.font = `bold 26px ${UTILITY}`;
  ctx.fillText('Start the camera below', W / 2, H / 2 - 8);
}

/** A soft shadow along the bottom, so the name stays readable on any picture. */
function shade() {
  const fade = ctx.createLinearGradient(0, H * .62, 0, H);
  fade.addColorStop(0, 'rgb(23 19 14 / 0)');
  fade.addColorStop(1, 'rgb(23 19 14 / .72)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, H * .62, W, H * .38);
}

/** The Flaky sign on the right: the monster in a circle, with its name under it. */
function sign() {
  const radius = 78;
  const cx = W - MARGIN - radius;
  const cy = H - MARGIN - 44 - radius;
  ctx.save();
  ctx.shadowColor = 'rgb(0 0 0 / .4)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#f5ead5';
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (monster.complete && monster.naturalWidth) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    const side = Math.min(monster.naturalWidth, monster.naturalHeight);
    ctx.drawImage(monster, (monster.naturalWidth - side) / 2, (monster.naturalHeight - side) / 2, side, side, cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff8ed';
  ctx.font = `bold 20px ${UTILITY}`;
  ctx.letterSpacing = '4px';
  ctx.fillText('FLAKY', cx + 2, H - MARGIN);
  ctx.letterSpacing = '0px';
}

/** "Jury of" and the name, at the bottom left, beside the sign. */
function caption() {
  const maxWidth = W - MARGIN * 2 - 220;
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgb(0 0 0 / .5)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgb(255 248 237 / .85)';
  ctx.font = `bold 24px ${UTILITY}`;
  ctx.letterSpacing = '6px';
  ctx.fillText('JURY OF', MARGIN, H - MARGIN - 78);
  ctx.letterSpacing = '0px';
  const name = juryName() || 'an undisclosed country';
  fit(name, maxWidth, 64, `italic 700 {size}px ${DISPLAY}`);
  ctx.fillStyle = '#fff8ed';
  ctx.fillText(name, MARGIN, H - MARGIN);
  ctx.shadowBlur = 0;
}

/** The file name, with the name of the jury: flaky-jury-austria.png. */
function fileName() {
  const slug = juryName().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `flaky-jury${slug ? `-${slug}` : ''}.png`;
}

/** Makes the file of the picture taken again, after the picture or the name changed. */
function refreshFile() {
  photoFile = null;
  if (!still) return;
  const taken = still;
  canvas.toBlob((blob) => {
    if (blob && still === taken) photoFile = new File([blob], fileName(), { type: 'image/png' });
  }, 'image/png');
}

/** The jury photo as a PNG file, or null when no picture has been taken. */
export const juryPhoto = () => photoFile;

/** Draws the whole picture: the live camera, the picture taken, or an empty frame. */
function draw() {
  ctx.clearRect(0, 0, W, H);
  if (still) photo(still, still.width, still.height, stillEyes);
  else if (stream && video.videoWidth) photo(video, video.videoWidth, video.videoHeight, monsterInView() ? eyes : null);
  else photo(null);
  shade();
  sign();
  caption();
}

/** Finds the faces in a new camera frame and paints the monster's eyes and tongue on them. */
function track() {
  if (!tracker || !video.videoWidth || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let faces = [];
  try {
    faces = tracker.detectForVideo(video, performance.now()).faceLandmarks;
  } catch (err) {
    console.warn('Face tracking failed, no monster filter:', err);
    tracker = null;
  }
  drawFaces(video, faces, eyes);
  if (faces.length) faceSeenAt = performance.now();
}

/** Whether a face is in view, so the monster filter is on. */
const monsterInView = () => performance.now() - faceSeenAt < LOOK_HOLD_MS;

function loop() {
  track();
  draw();
  frameRequest = requestAnimationFrame(loop);
}

function say(message) {
  $('photo-status').textContent = message;
}

/** Shows the buttons that fit: start, take, or download and take another. */
function render() {
  $('photo-start').hidden = Boolean(stream || still);
  $('photo-take').hidden = !stream || Boolean(still);
  $('photo-take').disabled = busy;
  $('photo-actions').hidden = !still;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    say('This browser cannot use the camera here. Try a recent browser, on a page served over HTTPS.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
  } catch {
    say('The camera is blocked or missing. Allow camera access for this page in your browser and try again.');
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  still = null;
  stillEyes = null;
  photoFile = null;
  say(tracker ? 'Look into the camera: the monster sees you.' : 'Loading the monster filter…');
  if (!tracker) {
    loadFaceTracker().then((loaded) => {
      tracker = loaded;
      if (stream) say('Look into the camera: the monster sees you.');
    }, (err) => {
      console.warn('Face tracker unavailable, no monster filter:', err);
      if (stream) say('The monster filter could not load, so the picture is taken without it.');
    });
  }
  cancelAnimationFrame(frameRequest);
  loop();
  render();
  $('photo-take').focus();
}

/** Turns the camera off, so its light goes off too. */
function stopCamera() {
  cancelAnimationFrame(frameRequest);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  lastVideoTime = -1;
  faceSeenAt = -Infinity;
}

async function countdown() {
  const overlay = $('photo-countdown');
  overlay.hidden = false;
  for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
    overlay.textContent = String(n);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  overlay.hidden = true;
}

async function takePicture() {
  if (!stream || busy) return;
  busy = true;
  render();
  await countdown();
  busy = false;
  if (!stream || !video.videoWidth) return render();
  // Keep the frame itself, not the finished picture, so a change of name still shows up on it.
  still = document.createElement('canvas');
  still.width = video.videoWidth;
  still.height = video.videoHeight;
  still.getContext('2d').drawImage(video, 0, 0);
  // The monster filter as it was at the click: with a face in view, its eyes and tongue go with the picture.
  stillEyes = null;
  if (monsterInView()) {
    stillEyes = document.createElement('canvas');
    stillEyes.width = eyes.width;
    stillEyes.height = eyes.height;
    if (eyes.width && eyes.height) stillEyes.getContext('2d').drawImage(eyes, 0, 0);
  }
  stopCamera();
  draw();
  refreshFile();
  render();
  say('Douze points! Download your jury photo, or take another. It also goes with your votes.');
  $('photo-download').focus();
}

/** Saves the jury photo to the device. */
export function downloadPhoto() {
  canvas.toBlob((blob) => {
    if (!blob) return say('The photo could not be saved in this browser.');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName();
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }, 'image/png');
}

/** The name on the photo and the name on the vote are the same field twice: typing in one fills the other. */
function syncJury(from, to) {
  from.addEventListener('input', () => {
    if (to.value !== from.value) {
      to.value = from.value;
      to.dispatchEvent(new Event('input'));
    }
    if (!stream) {
      draw();
      refreshFile();
    }
  });
}

syncJury($('photo-jury'), $('vote-jury'));
syncJury($('vote-jury'), $('photo-jury'));
$('vote-form').addEventListener('reset', () => setTimeout(() => {
  $('photo-jury').value = $('vote-jury').value;
  if (!stream) {
    draw();
    refreshFile();
  }
}));
$('photo-start').addEventListener('click', startCamera);
$('photo-take').addEventListener('click', takePicture);
$('photo-retake').addEventListener('click', startCamera);
$('photo-download').addEventListener('click', downloadPhoto);
// Leaving the page turns the camera off.
addEventListener('pagehide', stopCamera);
// Fonts may arrive after the first drawing.
document.fonts?.ready.then(() => {
  if (!stream) {
    draw();
    refreshFile();
  }
});

draw();
render();
