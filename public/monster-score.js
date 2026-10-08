/**
 * Monster score: how much a face looks like the Flaky Test Monster, from 0 (human) to
 * 100 (monster). The expression decides most of it, a smile clears you and a scowl
 * condemns you; the monster's own look (long hair, beard, glasses) adds to it.
 * Pure functions, no DOM, so the scoring can be checked in Node.
 */

/** Score of a neutral face with none of the monster's features. */
export const BASE_SCORE = 35;
/** Weight of the newest scan in the running score; the rest is the previous score. */
const SMOOTHING = 0.5;

/**
 * Traits the in-browser model is asked about, with the points each adds when present.
 * `question` is put to the model as a yes or no question.
 * @type {{ key: TraitKey, label: string, points: number, question: string }[]}
 */
export const TRAITS = [
  { key: 'smiling', label: 'smiling', points: -45, question: 'Is the person smiling?' },
  { key: 'angry', label: 'angry', points: 45, question: 'Does the person look angry, frowning or scowling?' },
  { key: 'longHair', label: 'long hair', points: 15, question: 'Does the person have long hair?' },
  { key: 'beard', label: 'beard', points: 15, question: 'Does the person have a beard?' },
  { key: 'glasses', label: 'glasses', points: 10, question: 'Is the person wearing glasses?' },
];

/** Verdicts by the lowest score that earns them, highest first. */
const VERDICTS = [
  { min: 60, key: 'monster', label: 'flaky test monster' },
  { min: 40, key: 'suspicious', label: 'suspicious' },
  { min: 0, key: 'human', label: 'human' },
];

/** @typedef {'smiling' | 'angry' | 'longHair' | 'beard' | 'glasses'} TraitKey */
/** @typedef {Record<TraitKey, boolean>} Traits */

/**
 * Turns whatever the model answered into a full set of booleans; a missing or odd value
 * counts as "no". Strings like "yes" or "true" count as yes.
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Traits}
 */
export function parseTraits(raw) {
  const yes = (value) => value === true || (typeof value === 'string' && /^\s*(yes|true)\b/i.test(value));
  return Object.fromEntries(TRAITS.map(({ key }) => [key, yes(raw?.[key])]));
}

/**
 * Score of one scan, clamped to 0..100.
 * @param {Traits} traits
 * @returns {number}
 */
export function monsterScore(traits) {
  const points = TRAITS.reduce((sum, { key, points }) => sum + (traits[key] ? points : 0), BASE_SCORE);
  return Math.min(100, Math.max(0, points));
}

/**
 * Blends a new scan into the running score so one odd answer does not flip the verdict.
 * @param {number | null} previous running score, or null before the first scan
 * @param {number} next score of the newest scan
 * @returns {number} rounded to a whole number
 */
export function smoothScore(previous, next) {
  return Math.round(previous === null ? next : previous * (1 - SMOOTHING) + next * SMOOTHING);
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
