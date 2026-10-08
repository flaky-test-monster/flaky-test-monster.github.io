import { TRAITS, parseTraits } from './monster-score.js';

/**
 * Runs a vision language model in the browser that looks at a webcam frame and says
 * which monster traits it sees. Nothing leaves the machine: the model is downloaded once
 * and cached by the browser.
 *
 * Two backends, tried in order:
 * - Chrome's built-in Prompt API (Gemini Nano) with image input, when the browser has it
 * - SmolVLM-256M through Transformers.js, on WebGPU when available, else WebAssembly
 */

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';
const SMOLVLM_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const PROMPT_API_OPTIONS = {
  expectedInputs: [{ type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const PROMPT_API_INSTRUCTIONS = [
  'Look at the person in this webcam photo and answer each question with true or false.',
  ...TRAITS.map(({ key, question }) => `${key}: ${question}`),
  'If there is no person in the photo, answer false to everything.',
].join('\n');
const TRAITS_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(TRAITS.map(({ key }) => [key, { type: 'boolean' }])),
  required: TRAITS.map(({ key }) => key),
  additionalProperties: false,
};

/**
 * @typedef {object} Detector
 * @property {string} name shown to the user, e.g. "Gemini Nano (Chrome)"
 * @property {(frame: HTMLCanvasElement) => Promise<import('./monster-score.js').Traits>} detect
 */

/**
 * Loads the first backend that works in this browser.
 * @param {(message: string) => void} onStatus loading progress for the user
 * @returns {Promise<Detector>}
 */
export async function loadDetector(onStatus) {
  return (await loadPromptApi(onStatus)) ?? loadSmolVlm(onStatus);
}

/**
 * Chrome's built-in model, or null when this browser does not offer it with image input.
 * @param {(message: string) => void} onStatus
 * @returns {Promise<Detector | null>}
 */
async function loadPromptApi(onStatus) {
  const { LanguageModel } = globalThis;
  if (!LanguageModel) return null;
  try {
    if ((await LanguageModel.availability(PROMPT_API_OPTIONS)) === 'unavailable') return null;
    onStatus('Loading Gemini Nano');
    const base = await LanguageModel.create({
      ...PROMPT_API_OPTIONS,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => onStatus(`Downloading Gemini Nano ${Math.round(event.loaded * 100)}%`));
      },
    });
    return {
      name: 'Gemini Nano (Chrome)',
      async detect(frame) {
        // A fresh copy per frame keeps earlier frames out of the context.
        const session = await base.clone();
        try {
          const answer = await session.prompt(
            [{ role: 'user', content: [{ type: 'text', value: PROMPT_API_INSTRUCTIONS }, { type: 'image', value: frame }] }],
            { responseConstraint: TRAITS_SCHEMA },
          );
          return parseTraits(JSON.parse(answer));
        } finally {
          session.destroy();
        }
      },
    };
  } catch (err) {
    console.warn('Prompt API unavailable, falling back to SmolVLM:', err);
    return null;
  }
}

/**
 * SmolVLM through Transformers.js. A model this small answers single yes or no questions
 * far more reliably than it fills in JSON, so it is asked about one trait at a time.
 * @param {(message: string) => void} onStatus
 * @returns {Promise<Detector>}
 */
async function loadSmolVlm(onStatus) {
  onStatus('Loading Transformers.js');
  const { AutoProcessor, AutoModelForVision2Seq, RawImage } = await import(TRANSFORMERS_URL);
  const webgpu = Boolean(await navigator.gpu?.requestAdapter().catch(() => null));
  const progress = {};
  const progressCallback = (event) => {
    if (event.status !== 'progress' || !event.total) return;
    progress[event.file] = [event.loaded, event.total];
    const [loaded, total] = Object.values(progress).reduce(([l, t], [fl, ft]) => [l + fl, t + ft], [0, 0]);
    onStatus(`Downloading SmolVLM ${Math.round((loaded / total) * 100)}%`);
  };
  const processor = await AutoProcessor.from_pretrained(SMOLVLM_ID, { progress_callback: progressCallback });
  const model = await AutoModelForVision2Seq.from_pretrained(SMOLVLM_ID, {
    device: webgpu ? 'webgpu' : 'wasm',
    dtype: webgpu
      ? { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' }
      : { embed_tokens: 'q8', vision_encoder: 'q8', decoder_model_merged: 'q8' },
    progress_callback: progressCallback,
  });

  /** Asks one yes or no question about the image and returns the raw answer. */
  async function ask(image, question) {
    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: `${question} Answer yes or no.` }] }];
    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(text, [image], { do_image_splitting: false });
    const ids = await model.generate({ ...inputs, max_new_tokens: 3, do_sample: false });
    const [answer] = processor.batch_decode(ids.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true });
    return answer;
  }

  return {
    name: `SmolVLM (${webgpu ? 'WebGPU' : 'WebAssembly'})`,
    async detect(frame) {
      const image = await RawImage.fromCanvas(frame);
      const answers = {};
      for (const { key, question } of TRAITS) answers[key] = await ask(image, question);
      return parseTraits(answers);
    },
  };
}
