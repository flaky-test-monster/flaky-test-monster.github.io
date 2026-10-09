// The kinds of figure a photo can become. Each preset holds the image prompt and, for the
// shape-list 3D step, a hint about what the figure is made of.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REFERENCE_DIR = path.join(import.meta.dirname, '..', 'figures');
const MONSTER_REFERENCE = 'flaky-test-monster.jpg';
/**
 * LEGO style LoRA for FLUX.1 Kontext (https://huggingface.co/Kontext-Style/LEGO_lora, about
 * 360 MB, downloaded by mflux on first use). It was trained with the instruction below, so
 * prompts that use it start with that sentence.
 */
const LEGO_LORA = { path: 'Kontext-Style/LEGO_lora:LEGO_lora_weights.safetensors', scale: 1 };
const LEGO_LORA_TRIGGER = 'Turn this image into the LEGO style.';

/**
 * @typedef {object} Figure
 * @property {string} label shown in the UI
 * @property {string} prompt image edit instruction for OpenAI
 * @property {string} [localPrompt] FLUX.1 Kontext variant, when the OpenAI prompt does not suit it
 * @property {{ path: string, scale: number }} [localLora] LoRA for FLUX.1 Kontext: a local file,
 *   a Hugging Face repo, or `repo:file.safetensors`
 * @property {string} sceneHint what the shape-list model should build
 * @property {string} [reference] optional reference image in figures/, sent along with the photo
 */

/** @type {Record<string, Figure>} */
export const FIGURES = {
  marble: {
    label: 'Marble bust',
    prompt:
      'Transform this person into a classical white marble bust statue. Head and shoulders only, ' +
      'single uniform matte marble material, no color, plain solid light gray background, ' +
      'front-facing, no text.',
    // Kontext follows edit instructions best with "change ... while keeping ..." phrasing.
    localPrompt:
      'Change this person into a classical white marble bust statue, head and shoulders only, ' +
      'while keeping the same facial features, hairstyle and expression. Single uniform matte ' +
      'marble material, no color, plain solid light gray background, front-facing, no text.',
    sceneHint:
      'Look at the marble bust in the image and model it: the head with its hair, face and ' +
      'distinctive features, the neck, and the shoulders on a round pedestal.',
  },
  lego: {
    label: 'LEGO minifigure',
    prompt:
      'Turn this person into a LEGO minifigure. Keep their hairstyle, hair color, facial hair, ' +
      'glasses, skin tone and clothing colors, with a printed minifigure face. Full body, ' +
      'standing straight, arms at the sides, front view, plain solid light gray background, ' +
      'no text, no logos.',
    localPrompt:
      `${LEGO_LORA_TRIGGER} Make the person a LEGO minifigure while keeping their hairstyle, ` +
      'hair color, facial hair, glasses, skin tone and clothing colors, with a printed ' +
      'minifigure face. Full body, standing straight, arms at the sides, front view, plain ' +
      'solid light gray background, no text, no logos.',
    localLora: LEGO_LORA,
    sceneHint:
      'Look at the LEGO minifigure in the image and model it: the cylindrical head with the stud ' +
      'on top, its hair piece, hat or helmet, the trapezoid torso, the arms and C-shaped hands, ' +
      'the hips and legs, standing on a thin round base plate. Match the proportions of a real ' +
      'minifigure and add the distinctive details (hair shape, glasses, beard, collar, hood).',
  },
  monster: {
    label: 'Flaky Test Monster',
    prompt:
      'Convert the webcam subject into a cute 3D-printable green monster figurine matching the ' +
      'reference: chunky round body, huge rectangular mouth with large irregular white teeth and ' +
      'red tongue, two oversized white eyes with small black pupils, and thick messy hair based ' +
      'on the person’s real hairstyle. Preserve recognizable features such as hair, glasses, ' +
      'beard, and clothing. Use sturdy simplified geometry, thick printable details, minimal ' +
      'overhangs, broad feet, and a clean freestanding pose suitable for a 10–15 cm FDM/PLA ' +
      'print. Plain background, full body, 3D sculpt preview.',
    sceneHint:
      'Look at the green monster figurine in the image and model it: the chunky round body, the ' +
      'huge rectangular mouth with its big teeth and tongue, the two oversized eyes, the messy ' +
      'hair, glasses or beard if present, short arms and broad feet on a thin round base plate.',
    reference: MONSTER_REFERENCE,
  },
  'monster-lego': {
    label: 'Monster LEGO minifigure',
    prompt:
      'Convert the webcam subject into a full-body LEGO-style minifigure version of the green ' +
      'monster reference, keeping it close to the original design: bright green body, huge ' +
      'rectangular mouth with large white teeth and red tongue, big round white eyes with black ' +
      'pupils, and spiky black hair. Preserve recognizable traits from the person such as ' +
      'hairstyle, glasses, beard, and clothing, but adapt everything into authentic LEGO ' +
      'minifigure proportions and plastic toy form with simple blocky geometry, articulated ' +
      'minifigure arms and hands, short LEGO legs, and a clean front-facing full-size ' +
      'collectible look on a plain background.',
    localPrompt:
      `${LEGO_LORA_TRIGGER} Make the person a full-body LEGO minifigure of a green monster: ` +
      'bright green body, huge rectangular mouth with large white teeth and red tongue, big ' +
      'round white eyes with black pupils, and spiky black hair, while keeping their ' +
      'hairstyle, glasses, beard and clothing. Minifigure proportions, front view, plain ' +
      'background, no text.',
    localLora: LEGO_LORA,
    sceneHint:
      'Look at the monster LEGO minifigure in the image and model it: the minifigure head with ' +
      'the huge mouth, big eyes and spiky hair piece, the trapezoid torso, the arms and C-shaped ' +
      'hands, the hips and short legs, standing on a thin round base plate. Match the ' +
      'proportions of a real minifigure and add the distinctive details (teeth, eyes, glasses, ' +
      'beard).',
    reference: MONSTER_REFERENCE,
  },
  'monster-playmobil': {
    label: 'Monster Playmobil pirate',
    prompt:
      'Convert the webcam subject into a full-body Playmobil-style pirate version of the green ' +
      'monster reference, keeping the original look recognizable: bright green body, huge ' +
      'rectangular mouth with big white teeth and red tongue, large round eyes, and spiky black ' +
      'hair. Preserve the person’s key traits such as hairstyle, glasses, beard, and clothing, ' +
      'but adapt them into classic Playmobil toy proportions with a smooth plastic look, ' +
      'simplified shapes, pirate outfit and accessories, and a clean full-body collectible ' +
      'presentation on a plain background.',
    sceneHint:
      'Look at the Playmobil pirate monster in the image and model it: the large round head with ' +
      'the huge mouth, big eyes and spiky hair, the pirate hat or bandana, the rounded torso with ' +
      'the pirate outfit, the arms with gripping hands, the legs and boots, and accessories such ' +
      'as a sword or hook, standing on a thin round base plate.',
    reference: MONSTER_REFERENCE,
  },
};

export const DEFAULT_FIGURE = 'monster';

/**
 * Loads the figure's reference image, if it has one and the file is present. The reference
 * is optional: without it the prompt's own description has to carry the look.
 * @param {Figure} figure
 * @returns {Promise<Buffer | null>} JPEG bytes, or null
 */
export async function loadReference(figure) {
  if (!figure.reference) return null;
  try {
    return await readFile(path.join(REFERENCE_DIR, figure.reference));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
