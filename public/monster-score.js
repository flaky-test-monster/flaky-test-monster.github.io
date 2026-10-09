/**
 * Monster score: how much a face looks like the Flaky Test Monster, from 0 (human) to
 * 100 (monster). It is all in the mouth: closed is human, wide open is a monster.
 * Pure functions, no DOM, so the scoring can be checked in Node.
 */

/** Weight of the newest frame in the running score; the rest is the previous score. */
const SMOOTHING = 0.3;
/** Mouth openness (lip gap over mouth width) at or below which the score is 0. */
const MOUTH_CLOSED = 0.05;
/** Mouth openness at or above which the score is 100. */
const MOUTH_OPEN = 0.6;
/** Face landmarks: inner upper lip, inner lower lip, left and right mouth corners. */
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;
/** Nose tip landmark, used to follow a face from one frame to the next. */
const NOSE = 1;
/** Furthest a nose can move between frames, as a share of frame height, and still be the same face. */
const MATCH_DISTANCE = 0.15;
/** Mouth score above which a monster waving earns the bonus. */
export const WAVE_FROM = 90;
/** Points a waving monster gets on top of its mouth score. */
export const WAVE_BONUS = 50;
/** Palm center landmark of a hand, followed to spot a wave. */
const PALM = 9;
/** Furthest a palm can move between frames, as a share of frame height, and still be the same hand. */
const HAND_MATCH_DISTANCE = 0.2;
/** How far back a hand's movement is looked at to spot a wave. */
const WAVE_WINDOW_MS = 1500;
/** Sideways movement, as a share of frame width, that counts as one swing of a wave. */
const WAVE_SWING = 0.04;
/** Swings within the window that make a wave: left, right, left or the other way round. */
const WAVE_SWINGS = 3;

/** Verdicts by the lowest score that earns them, highest first. */
const VERDICTS = [
  { min: 60, key: 'monster', label: 'flaky test monster' },
  { min: 40, key: 'suspicious', label: 'suspicious' },
  { min: 0, key: 'human', label: 'human' },
];

/**
 * How far the mouth is open: the gap between the lips over the width of the mouth, so it
 * does not depend on how close the face is to the camera.
 * @param {{ x: number, y: number }[]} landmarks MediaPipe face landmarks, normalized 0..1
 * @param {number} aspect frame width over height, since x and y are normalized separately
 * @returns {number} about 0 when closed, 0.6 or more when wide open
 */
export function mouthOpenness(landmarks, aspect) {
  const distance = (a, b) => Math.hypot((landmarks[a].x - landmarks[b].x) * aspect, landmarks[a].y - landmarks[b].y);
  const width = distance(MOUTH_LEFT, MOUTH_RIGHT);
  return width > 0 ? distance(UPPER_LIP, LOWER_LIP) / width : 0;
}

/**
 * Score of one frame, 0..100.
 * @param {number} openness from mouthOpenness
 * @returns {number}
 */
export function monsterScore(openness) {
  const share = (openness - MOUTH_CLOSED) / (MOUTH_OPEN - MOUTH_CLOSED);
  return Math.min(100, Math.max(0, share * 100));
}

/**
 * Blends a new frame into the running score so the meter does not jitter.
 * @param {number | null} previous running score, or null before the first frame
 * @param {number} next score of the newest frame
 * @returns {number} not rounded, since rounding every frame would stop it short of 0 and 100
 */
export function smoothScore(previous, next) {
  return previous === null ? next : previous * (1 - SMOOTHING) + next * SMOOTHING;
}

/**
 * Index of the point nearest to a target, or -1 when none is within the limit.
 * @param {{ x: number, y: number }[]} points
 * @param {{ x: number, y: number }} target
 * @param {number} aspect frame width over height
 * @param {number} limit
 */
function nearestIndex(points, target, aspect, limit = Infinity) {
  let nearest = -1;
  let nearestDistance = limit;
  points.forEach((point, i) => {
    const distance = Math.hypot((point.x - target.x) * aspect, point.y - target.y);
    if (distance < nearestDistance) [nearest, nearestDistance] = [i, distance];
  });
  return nearest;
}

/**
 * @typedef {object} TrackedFace
 * @property {{ x: number, y: number }[]} landmarks
 * @property {{ x: number, y: number }} nose
 * @property {number} mouth mouth score of this frame, 0..100
 * @property {boolean} waving whether this face earns the wave bonus in this frame
 * @property {number} score running score of this face, up to 100 plus the wave bonus
 */

/**
 * Scores every face in a new frame. Each one carries on the running score of the nearest
 * face in the last frame, so a person keeps their score as they move and does not flicker
 * in and out of being a monster. A face with a mouth score above WAVE_FROM whose nearest
 * hand waves gets WAVE_BONUS on top.
 * @param {TrackedFace[]} previous faces of the last frame
 * @param {{ x: number, y: number }[][]} faces landmarks per face in the new frame
 * @param {number} aspect frame width over height
 * @param {{ x: number, y: number }[]} [wavingHands] palms of the hands waving in the new frame
 * @returns {TrackedFace[]}
 */
export function trackFaces(previous, faces, aspect, wavingHands = []) {
  const unclaimed = [...previous];
  const noses = faces.map((landmarks) => landmarks[NOSE]);
  const waved = new Set(wavingHands.map((palm) => nearestIndex(noses, palm, aspect)));
  return faces.map((landmarks, i) => {
    const nose = noses[i];
    const nearest = nearestIndex(unclaimed.map((face) => face.nose), nose, aspect, MATCH_DISTANCE);
    const [match] = nearest >= 0 ? unclaimed.splice(nearest, 1) : [];
    const mouth = monsterScore(mouthOpenness(landmarks, aspect));
    const waving = mouth > WAVE_FROM && waved.has(i);
    const score = smoothScore(match?.score ?? null, mouth + (waving ? WAVE_BONUS : 0));
    return { landmarks, nose, mouth, waving, score };
  });
}

/**
 * @typedef {object} TrackedHand
 * @property {{ x: number, y: number }} palm
 * @property {{ x: number, time: number }[]} trail where the palm was across the wave window, oldest first
 */

/**
 * Follows every hand in a new frame, each one carrying on the trail of the nearest hand in
 * the last frame, trimmed to the wave window.
 * @param {TrackedHand[]} previous hands of the last frame
 * @param {{ x: number, y: number }[][]} hands landmarks per hand in the new frame
 * @param {number} aspect frame width over height
 * @param {number} time of the new frame, in milliseconds
 * @returns {TrackedHand[]}
 */
export function trackHands(previous, hands, aspect, time) {
  const unclaimed = [...previous];
  return hands.map((landmarks) => {
    const palm = landmarks[PALM];
    const nearest = nearestIndex(unclaimed.map((hand) => hand.palm), palm, aspect, HAND_MATCH_DISTANCE);
    const [match] = nearest >= 0 ? unclaimed.splice(nearest, 1) : [];
    const trail = [...(match?.trail ?? []), { x: palm.x, time }].filter((point) => time - point.time <= WAVE_WINDOW_MS);
    return { palm, trail };
  });
}

/**
 * Whether a hand is waving: its palm swung from side to side at least WAVE_SWINGS times
 * within the wave window, each swing at least WAVE_SWING of the frame width.
 * @param {TrackedHand} hand
 * @returns {boolean}
 */
export function isWaving(hand) {
  let extreme = hand.trail[0]?.x;
  let direction = 0;
  let swings = 0;
  for (const { x } of hand.trail) {
    if (direction === 0) {
      if (Math.abs(x - extreme) >= WAVE_SWING) [direction, extreme, swings] = [Math.sign(x - extreme), x, 1];
    } else if ((x - extreme) * direction > 0) {
      // Still swinging the same way: the turning point moves along.
      extreme = x;
    } else if ((extreme - x) * direction >= WAVE_SWING) {
      [direction, extreme, swings] = [-direction, x, swings + 1];
    }
  }
  return swings >= WAVE_SWINGS;
}

/**
 * Verdict for a score.
 * @param {number} score
 * @returns {{ min: number, key: 'human' | 'suspicious' | 'monster', label: string }}
 */
export function verdict(score) {
  return VERDICTS.find(({ min }) => score >= min);
}
