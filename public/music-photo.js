/**
 * The jury photo on the music page: a selfie from the webcam in a Eurovision Monster Contest
 * frame, with the name of the jury on a scoreboard plate, to download as a PNG. Everything is
 * drawn on a canvas in this page; the photo never leaves the device, unless it goes with the
 * votes (music-vote.js).
 */

const $ = (id) => document.getElementById(id);
const canvas = $('photo-canvas');
const ctx = canvas.getContext('2d');
const video = $('photo-video');
const W = canvas.width;
const H = canvas.height;
const COUNTDOWN_SECONDS = 3;
/** The photo inside the frame, and the heart with the 12 points on its top right corner. */
const FRAME = { x: 70, y: 230, w: 940, h: 820, r: 28 };
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
/** The finished picture as a PNG file, made ahead of time: sharing it must start right on the
 * click, and the browser forgets the click while the canvas is still being encoded. */
let photoFile = null;

/** The name of the jury, shared with the vote: whoever votes is in the picture. */
const juryName = () => $('photo-jury').value.replace(/\s+/g, ' ').trim();

/** Sparkles that do not move between frames: the same pseudo-random places every time. */
const SPARKLES = Array.from({ length: 70 }, (_, i) => {
  const r = (n) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  return { x: r(1) * W, y: r(2) * H, size: 1 + r(3) * 3.5, alpha: .25 + r(4) * .6 };
});

function heart(x, y, size) {
  ctx.beginPath();
  ctx.moveTo(x, y + size * .3);
  ctx.bezierCurveTo(x, y, x - size / 2, y, x - size / 2, y + size * .3);
  ctx.bezierCurveTo(x - size / 2, y + size * .6, x, y + size * .78, x, y + size);
  ctx.bezierCurveTo(x, y + size * .78, x + size / 2, y + size * .6, x + size / 2, y + size * .3);
  ctx.bezierCurveTo(x + size / 2, y, x, y, x, y + size * .3);
  ctx.closePath();
}

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

function background() {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#12062a');
  sky.addColorStop(.55, '#4b0b45');
  sky.addColorStop(1, '#921f1a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // Stage lights: beams fanning out from the top.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [from, to, colour] of [[180, -120, '255 80 200'], [540, 540, '120 160 255'], [900, 1200, '255 200 90']]) {
    const beam = ctx.createLinearGradient(from, 0, to, H);
    beam.addColorStop(0, `rgb(${colour} / .35)`);
    beam.addColorStop(1, `rgb(${colour} / 0)`);
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(from - 20, 0);
    ctx.lineTo(from + 20, 0);
    ctx.lineTo(to + 260, H);
    ctx.lineTo(to - 260, H);
    ctx.fill();
  }
  for (const { x, y, size, alpha } of SPARKLES) {
    ctx.fillStyle = `rgb(255 240 210 / ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function header() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f7c948';
  ctx.font = `bold 32px ${UTILITY}`;
  ctx.letterSpacing = '8px';
  ctx.fillText('EUROVISION MONSTER CONTEST', W / 2, 92);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = '#fff8ed';
  ctx.font = `italic 900 88px ${DISPLAY}`;
  ctx.shadowColor = 'rgb(255 60 170 / .8)';
  ctx.shadowBlur = 30;
  ctx.fillText('From Flaky With Love', W / 2, 190);
  ctx.shadowBlur = 0;
}

function photo(source, width, height) {
  const { x, y, w, h, r } = FRAME;
  ctx.save();
  ctx.shadowColor = 'rgb(255 60 170 / .9)';
  ctx.shadowBlur = 50;
  ctx.fillStyle = '#17130e';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  if (source) {
    cover(source, width, height, FRAME);
  } else {
    ctx.fillStyle = 'rgb(255 248 237 / .7)';
    ctx.textAlign = 'center';
    ctx.font = `italic 700 56px ${DISPLAY}`;
    ctx.fillText('Your face here', x + w / 2, y + h / 2);
    ctx.font = `bold 26px ${UTILITY}`;
    ctx.fillText('Start the camera below', x + w / 2, y + h / 2 + 52);
  }
  ctx.restore();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#f7c948';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();
}

/** The heart with douze points, stuck on the top right corner of the photo. */
function points() {
  ctx.save();
  ctx.translate(FRAME.x + FRAME.w - 60, FRAME.y + 80);
  ctx.rotate(.18);
  ctx.shadowColor = 'rgb(0 0 0 / .45)';
  ctx.shadowBlur = 20;
  heart(0, -80, 190);
  ctx.fillStyle = '#e0245e';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#fff8ed';
  ctx.stroke();
  ctx.fillStyle = '#fff8ed';
  ctx.textAlign = 'center';
  ctx.font = `900 76px ${DISPLAY}`;
  ctx.fillText('12', 0, 20);
  ctx.font = `bold 22px ${UTILITY}`;
  ctx.fillText('POINTS', 0, 48);
  ctx.restore();
}

/** The monster in a circle, peeking over the bottom left corner of the photo. */
function mascot() {
  const cx = 180;
  const cy = 1060;
  const radius = 115;
  ctx.save();
  ctx.shadowColor = 'rgb(0 0 0 / .5)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#f5ead5';
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (!monster.complete || !monster.naturalWidth) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  const side = Math.min(monster.naturalWidth, monster.naturalHeight);
  ctx.drawImage(monster, (monster.naturalWidth - side) / 2, (monster.naturalHeight - side) / 2, side, side, cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.restore();
}

/** The scoreboard plate with the name of the jury, as the hosts read them out on the night. */
function plate() {
  const x = 320;
  const y = 1095;
  const w = 690;
  const h = 130;
  ctx.save();
  ctx.shadowColor = 'rgb(0 0 0 / .45)';
  ctx.shadowBlur = 24;
  const fill = ctx.createLinearGradient(x, 0, x + w, 0);
  fill.addColorStop(0, '#fff8ed');
  fill.addColorStop(1, '#f5ead5');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 16);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#921f1a';
  ctx.beginPath();
  ctx.roundRect(x, y, 18, h, [16, 0, 0, 16]);
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#921f1a';
  ctx.font = `bold 26px ${UTILITY}`;
  ctx.letterSpacing = '6px';
  ctx.fillText('JURY OF', x + 44, y + 42);
  ctx.letterSpacing = '0px';
  const name = juryName() || 'an undisclosed country';
  fit(name, w - 80, 64, `italic 700 {size}px ${DISPLAY}`);
  ctx.fillStyle = '#17130e';
  ctx.fillText(name, x + 44, y + 106);
}

function footer() {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgb(255 248 237 / .85)';
  ctx.font = `bold 24px ${UTILITY}`;
  ctx.fillText(`Live from the jury room · ${date}`, W / 2, 1300);
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
  background();
  header();
  if (still) photo(still, still.width, still.height);
  else if (stream && video.videoWidth) photo(video, video.videoWidth, video.videoHeight);
  else photo(null);
  points();
  mascot();
  plate();
  footer();
}

function loop() {
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
  photoFile = null;
  say('Smile for the monster!');
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
