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
 * @typedef {object} TrackedFace
 * @property {{ x: number, y: number }[]} landmarks
 * @property {{ x: number, y: number }} nose
 * @property {number} score running score of this face
 */

/**
 * Scores every face in a new frame. Each one carries on the running score of the nearest
 * face in the last frame, so a person keeps their score as they move and does not flicker
 * in and out of being a monster.
 * @param {TrackedFace[]} previous faces of the last frame
 * @param {{ x: number, y: number }[][]} faces landmarks per face in the new frame
 * @param {number} aspect frame width over height
 * @returns {TrackedFace[]}
 */
export function trackFaces(previous, faces, aspect) {
  const unclaimed = [...previous];
  return faces.map((landmarks) => {
    const nose = landmarks[NOSE];
    let nearest = -1;
    let nearestDistance = MATCH_DISTANCE;
    unclaimed.forEach((face, i) => {
      const distance = Math.hypot((face.nose.x - nose.x) * aspect, face.nose.y - nose.y);
      if (distance < nearestDistance) [nearest, nearestDistance] = [i, distance];
    });
    const [match] = nearest >= 0 ? unclaimed.splice(nearest, 1) : [];
    const score = smoothScore(match?.score ?? null, monsterScore(mouthOpenness(landmarks, aspect)));
    return { landmarks, nose, score };
  });
}

/**
 * Verdict for a score.
 * @param {number} score
 * @returns {{ key: 'human' | 'suspicious' | 'monster', label: string }}
 */
export function verdict(score) {
  const { key, label } = VERDICTS.find(({ min }) => score >= min) ?? VERDICTS.at(-1);
  return { key, label };
}
