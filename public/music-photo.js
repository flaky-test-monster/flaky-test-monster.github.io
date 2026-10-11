/**
 * The jury photo on the music page: a selfie from the webcam with a broadcast-style overlay, a
 * live tag at the top and a semi-transparent panel at the bottom with the name, the song that
 * gets the douze points and the Flaky sign, to download as a PNG. The monster
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
const MARGIN = 48;
/** The panel at the bottom, the lower third, and the sign inside it on the right. */
const PANEL = { x: MARGIN, y: H - MARGIN - 240, w: W - MARGIN * 2, h: 240, r: 24 };
const SIGN_RADIUS = 68;
const GOLD = '#f7c948';
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
/** The start page's monster look at full strength, as in style.css and monster-face.js. */
const POSTER_FILTER = 'grayscale(1) contrast(7) brightness(1.15)';
const MONSTER_GREEN = 'rgb(47 209 47)';
/** How long the filter stays on after the face is lost, so a face the tracker misses for a
    few frames does not make the picture flicker. */
const LOOK_HOLD_MS = 500;
const DISPLAY = "'Bodoni MT', Didot, 'Times New Roman', serif";

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

/** The name in the picture. */
const photoName = () => $('photo-name').value.replace(/\s+/g, ' ').trim();

/** The song with the douze points, as chosen next to the songs (music-vote.js marks it), or null. */
const winner = () => document.querySelector('.song-top h3')?.textContent.trim() || null;

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
  // The start button sits in the middle of this (music.html).
  const dark = ctx.createRadialGradient(W / 2, H * .45, 0, W / 2, H * .45, H * .75);
  dark.addColorStop(0, '#3a2a24');
  dark.addColorStop(1, '#0d0a08');
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, W, H);
}

/**
 * Frosted glass: the picture under the box blurred, where the browser can, then a dark veil
 * and a fine light edge, so text on it reads well on any picture.
 */
function glass({ x, y, w, h, r }, veil = .5) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  if ('filter' in ctx) {
    ctx.filter = 'blur(18px)';
    ctx.drawImage(canvas, x - 40, y - 40, w + 80, h + 80, x - 40, y - 40, w + 80, h + 80);
    ctx.filter = 'none';
  }
  ctx.fillStyle = `rgb(12 9 8 / ${veil})`;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  ctx.strokeStyle = 'rgb(255 255 255 / .18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x + 1, y + 1, w - 2, h - 2, r);
  ctx.stroke();
}

/** A live tag on the top left, as on a broadcast. */
function liveTag() {
  const label = 'LIVE · FROM FLAKY WITH LOVE';
  ctx.font = `bold 28px ${SANS}`;
  ctx.letterSpacing = '3px';
  const box = { x: MARGIN, y: MARGIN, w: ctx.measureText(label).width + 84, h: 64, r: 32 };
  glass(box, .45);
  ctx.fillStyle = '#e0245e';
  ctx.beginPath();
  ctx.arc(box.x + 32, box.y + box.h / 2, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `bold 28px ${SANS}`;
  ctx.letterSpacing = '3px';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, box.x + 56, box.y + box.h / 2 + 1);
  ctx.letterSpacing = '0px';
  ctx.textBaseline = 'alphabetic';
}

/**
 * The lower third: the name, the song that gets the douze points, and the Flaky sign on the
 * right, on a semi-transparent panel.
 */
function lowerThird() {
  const { x, y, w, h } = PANEL;
  glass(PANEL);
  const left = x + 40;
  const signX = x + w - 40 - SIGN_RADIUS;
  const textWidth = signX - SIGN_RADIUS - 32 - left;

  ctx.textAlign = 'left';
  const name = photoName() || 'The Flaky Jury';
  fit(name, textWidth, 76, `italic 700 {size}px ${DISPLAY}`);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, left, y + 92);

  ctx.fillStyle = 'rgb(255 255 255 / .2)';
  ctx.fillRect(left, y + 120, textWidth, 2);

  ctx.font = `bold 28px ${SANS}`;
  ctx.letterSpacing = '3px';
  ctx.fillStyle = GOLD;
  ctx.fillText('DOUZE POINTS GO TO', left, y + 164);
  ctx.letterSpacing = '0px';
  const song = winner();
  fit(song ?? 'the song still to be chosen…', textWidth, 42, `600 {size}px ${SANS}`);
  ctx.fillStyle = song ? '#fff' : 'rgb(255 255 255 / .6)';
  ctx.fillText(song ?? 'the song still to be chosen…', left, y + 212);

  // The Flaky sign: the monster in a circle, with its name under it.
  const cy = y + 100;
  ctx.fillStyle = 'rgb(255 255 255 / .9)';
  ctx.beginPath();
  ctx.arc(signX, cy, SIGN_RADIUS + 4, 0, Math.PI * 2);
  ctx.fill();
  if (monster.complete && monster.naturalWidth) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(signX, cy, SIGN_RADIUS, 0, Math.PI * 2);
    ctx.clip();
    const side = Math.min(monster.naturalWidth, monster.naturalHeight);
    ctx.drawImage(monster, (monster.naturalWidth - side) / 2, (monster.naturalHeight - side) / 2, side, side, signX - SIGN_RADIUS, cy - SIGN_RADIUS, SIGN_RADIUS * 2, SIGN_RADIUS * 2);
    ctx.restore();
  }
  ctx.textAlign = 'center';
  ctx.font = `bold 24px ${SANS}`;
  ctx.letterSpacing = '5px';
  ctx.fillStyle = '#fff';
  ctx.fillText('FLAKY', signX + 3, y + h - 20);
  ctx.letterSpacing = '0px';
}

/** The file name, with the name of the jury: flaky-jury-austria.png. */
function fileName() {
  const slug = photoName().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
  liveTag();
  lowerThird();
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
  say('Douze points! It goes with your votes too.');
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

/** Draws the picture again after a change of name or douze points, and remakes its file. */
function redraw() {
  if (stream) return;
  draw();
  refreshFile();
}

$('photo-name').addEventListener('input', redraw);
// The douze points are chosen next to the songs; music-vote.js marks the song before this runs.
document.addEventListener('change', (event) => {
  if (event.target.closest?.('.song-vote')) redraw();
});
$('vote-form').addEventListener('reset', () => setTimeout(redraw));
$('photo-start').addEventListener('click', startCamera);
$('photo-take').addEventListener('click', takePicture);
$('photo-retake').addEventListener('click', startCamera);
$('photo-download').addEventListener('click', downloadPhoto);
// Leaving the page turns the camera off.
addEventListener('pagehide', stopCamera);
// Fonts may arrive after the first drawing.
document.fonts?.ready.then(redraw);

draw();
render();
