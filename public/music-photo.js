/**
 * The jury photo on the music page: a selfie from the webcam with a broadcast-style overlay, a
 * live tag at the top and a semi-transparent panel at the bottom with the name, the song that
 * gets the douze points and the Flaky sign, to download as a PNG. The monster filter of the
 * start page is always on while a face is in view: the green poster look, and the monster's
 * eyes and tongue on every face. Everything is drawn on a canvas in this page; the photo never
 * leaves the device, unless it is shared (music-vote.js). This module also owns the name of
 * the jury member and its check, which the vote uses too.
 */

import { drawFaces, loadFaceTracker, posterize } from './monster-face.js';

const $ = (id) => document.getElementById(id);
const canvas = $('photo-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: !('filter' in CanvasRenderingContext2D.prototype) });
const video = $('photo-video');
/** The picture's size; drawing is in these units at any resolution. */
const W = canvas.width;
const H = canvas.height;
/** The live preview is drawn at half resolution, which is plenty for the preview on screen and
    a quarter of the work per frame; the picture taken is drawn at full resolution. */
const LIVE_SCALE = .5;
const COUNTDOWN_SECONDS = 3;
/** Longest name, from the field's maxlength in music.html: it has to fit on the picture. */
const NAME_MAX = $('jury-name').maxLength;
/** The space kept free along the edges of the picture. */
const MARGIN = 48;
/** The panel at the bottom, the lower third, and the sign inside it on the right. On the wide
    picture it keeps to the left, as on TV, at a width that suits the name and the song. */
const PANEL = { x: MARGIN, y: H - MARGIN - 240, w: Math.min(W - MARGIN * 2, 1000), h: 240, r: 24 };
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
const NO_WINNER = 'the song still to be chosen…';

const monster = new Image();
monster.src = 'public/monster.jpg';
// The sign may arrive after the first drawing, or even after the picture is taken.
monster.addEventListener('load', () => redraw());

/** @type {MediaStream | null} */
let stream = null;
/** The picture taken, as the raw camera frame, or null while the camera is live. */
let still = null;
let frameRequest = 0;
/** Bumped whenever the camera is stopped, so a camera that arrives after that is let go. */
let cameraRun = 0;
/** Whether the camera is being asked for, so a second click cannot open a second stream. */
let starting = false;
/** Bumped when a picture is cancelled, so a countdown under way takes none. */
let captureRun = 0;
/** Whether the countdown runs. */
let busy = false;
/** The camera frame and the filter last drawn, so an unchanged frame is not drawn again. */
let lastDrawn = '';
/** The latest request for the photo file: an older one finishing last must not win. */
let fileRequest = 0;
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

/** A fantasy monster name, made up once per visit, for a jury member who enters none:
    "Gloomfang the Flaky". Every one fits in the name's 24 characters. */
const MONSTER_NAME = (() => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const start = pick(['Grim', 'Gloom', 'Snarl', 'Bog', 'Fizz', 'Murk', 'Grub', 'Wobble', 'Crag', 'Snag', 'Glob', 'Flake']);
  const end = pick(['fang', 'tooth', 'claw', 'snout', 'maw', 'horn', 'belly', 'toe', 'wart', 'bottom']);
  return `${start}${end} ${pick(['the Flaky', 'the Retried', 'the Skipped', 'the Red'])}`;
})();

/** What was typed in the name field, tidied up; empty when nothing was. */
const typedName = () => $('jury-name').value.replace(/\s+/g, ' ').trim();

/** The name of the jury member, in the picture and on the votes: the one typed, or the monster name. */
export const juryName = () => typedName() || MONSTER_NAME;

/**
 * Checks a typed name before the camera starts, the votes go out or the photo is saved, and
 * shows what is wrong at the field: it needs a letter or number, and fits on the picture.
 * No name is fine: the jury member then goes by the monster name.
 * @returns {boolean} whether the name is fine
 */
export function checkName({ focus = true } = {}) {
  const name = typedName();
  const error = !name ? ''
    : !/[\p{L}\p{N}]/u.test(name) ? 'Your name needs at least one letter or number.'
    : name.length > NAME_MAX ? `Your name can have up to ${NAME_MAX} characters.`
    : '';
  showNameError(error);
  if (error && focus) $('jury-name').focus();
  return !error;
}

/** Marks the name field as wrong with the message, or clears it with an empty one. */
function showNameError(message) {
  $('jury-name').setAttribute('aria-invalid', String(Boolean(message)));
  $('jury-name-error').textContent = message;
  $('jury-name-error').hidden = !message;
}

/** The song with the douze points, as chosen next to the songs, or null. Read from the choices
    themselves, which are up to date even before music-vote.js has marked the song. */
const winner = () => [...document.querySelectorAll('.song-vote select')]
  .find((select) => select.value === '12')?.closest('.song').querySelector('h3').textContent.trim() ?? null;

/** Sets the largest font, up to size, at which text fits in maxWidth. */
function fit(text, maxWidth, size, font) {
  for (; size > 12; size -= 2) {
    ctx.font = font.replace('{size}', size);
    if (ctx.measureText(text).width <= maxWidth) return;
  }
}

/** Sets the resolution of the canvas, as a share of the picture's full size. */
function setScale(scale) {
  if (canvas.width === Math.round(W * scale)) return;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
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
  if (!source) {
    // The start button sits in the middle of this (music.html).
    const dark = ctx.createRadialGradient(W / 2, H * .4, 0, W / 2, H * .4, W * .6);
    dark.addColorStop(0, '#3a2a24');
    dark.addColorStop(1, '#0d0a08');
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, W, H);
  } else if (!faces) {
    cover(source, width, height, all);
  } else if ('filter' in ctx) {
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
    posterize(ctx, canvas.width, canvas.height, { strength: 1, green: true });
  }
  if (source && faces?.width && faces.height) cover(faces, faces.width, faces.height, all);
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
    // The canvas as a source is in its own pixels, the destination in the picture's units.
    const scale = canvas.width / W;
    ctx.filter = 'blur(18px)';
    ctx.drawImage(canvas, (x - 40) * scale, (y - 40) * scale, (w + 80) * scale, (h + 80) * scale, x - 40, y - 40, w + 80, h + 80);
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
  const name = juryName();
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
  fit(song ?? NO_WINNER, textWidth, 42, `600 {size}px ${SANS}`);
  ctx.fillStyle = song ? '#fff' : 'rgb(255 255 255 / .6)';
  ctx.fillText(song ?? NO_WINNER, left, y + 212);

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

/** The file name, with the name of the jury member: flaky-jury-anna-banana.png. */
function fileName() {
  const slug = juryName().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `flaky-jury${slug ? `-${slug}` : ''}.png`;
}

/** Makes the file of the picture taken again, after the picture or the name changed. */
function refreshFile() {
  photoFile = null;
  const request = ++fileRequest;
  if (!still) return;
  const name = fileName();
  canvas.toBlob((blob) => {
    if (blob && request === fileRequest) photoFile = new File([blob], name, { type: 'image/png' });
  }, 'image/png');
}

/** The jury photo as a PNG file, or null when no picture has been taken. */
export const juryPhoto = () => photoFile;

/** Draws the whole picture: the live camera, the picture taken, or an empty frame. */
function draw() {
  setScale(still || !stream ? 1 : LIVE_SCALE);
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

/** Draws the live camera, but only when there is a new frame or the filter goes on or off. */
function loop() {
  track();
  const frame = `${video.currentTime} ${monsterInView()}`;
  if (frame !== lastDrawn) {
    lastDrawn = frame;
    draw();
  }
  frameRequest = requestAnimationFrame(loop);
}

/** Shows a message under the photo; music-vote.js uses it for sharing. */
export function sayPhoto(message) {
  $('photo-status').textContent = message;
}
const say = sayPhoto;

/** Shows the buttons that fit: start, take, or download, share and retake. */
function render() {
  $('photo-start').hidden = Boolean(stream || still);
  $('photo-take').hidden = !stream || Boolean(still);
  $('photo-take').disabled = busy;
  $('photo-actions').hidden = !still;
}

async function startCamera() {
  // The name first: the picture is made with it.
  if (stream || starting || !checkName()) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    say('This browser cannot use the camera here. Try a recent browser, on a page served over HTTPS.');
    return;
  }
  starting = true;
  const run = cameraRun;
  let started;
  try {
    started = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1600 }, aspectRatio: { ideal: 16 / 9 } }, audio: false });
  } catch {
    if (run === cameraRun) say('The camera is blocked or missing. Allow camera access for this page in your browser and try again.');
    return;
  } finally {
    starting = false;
  }
  // Left the page or started over while the browser asked: the camera is not wanted any more.
  if (run !== cameraRun) {
    started.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = started;
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
  cameraRun += 1;
  cancelAnimationFrame(frameRequest);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  lastVideoTime = -1;
  lastDrawn = '';
  faceSeenAt = -Infinity;
}

/** Counts down 3, 2, 1, unless the picture is cancelled on the way. */
async function countdown(run) {
  const overlay = $('photo-countdown');
  overlay.hidden = false;
  for (let n = COUNTDOWN_SECONDS; n > 0 && run === captureRun; n--) {
    overlay.textContent = String(n);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  overlay.hidden = true;
}

async function takePicture() {
  if (!stream || busy) return;
  const run = captureRun;
  busy = true;
  render();
  await countdown(run);
  if (run !== captureRun) return;
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
  say('Douze points! Your jury photo is ready.');
  $('photo-download').focus();
}

/** Saves the jury photo to the device. */
function downloadPhoto() {
  if (!checkName()) return;
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

/** How many of the characters the name may have are used, counted as maxlength counts them. */
function renderCount() {
  $('jury-name-count').textContent = `${$('jury-name').value.length}/${NAME_MAX}`;
}

/** Cancels a countdown under way and turns the camera off. */
function cancelCamera() {
  captureRun += 1;
  busy = false;
  $('photo-countdown').hidden = true;
  stopCamera();
}

$('jury-name').addEventListener('input', () => {
  renderCount();
  // Once marked wrong, the field says as soon as it is fine again.
  if ($('jury-name').getAttribute('aria-invalid') === 'true') checkName({ focus: false });
  redraw();
});
// The douze points are chosen next to the songs; music-vote.js marks the song before this runs.
document.addEventListener('change', (event) => {
  if (event.target.closest?.('.song-vote')) redraw();
});
$('photo-start').addEventListener('click', startCamera);
$('photo-take').addEventListener('click', takePicture);
$('photo-retake').addEventListener('click', startCamera);
$('photo-download').addEventListener('click', downloadPhoto);
// Leaving the page turns the camera off, and the buttons with it, for when Back brings the page back.
addEventListener('pagehide', () => {
  cancelCamera();
  render();
});
// Fonts may arrive after the first drawing.
document.fonts?.ready.then(redraw);

// The empty field shows the monster name its jury member will go by.
$('jury-name').placeholder = `${MONSTER_NAME}, or type your name`;
renderCount();
draw();
render();
