const OPENAI_EDIT_URL = 'https://api.openai.com/v1/images/edits';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
const OUTPUT_SIZE = '1024x1024';
const INPUT_FIDELITY = 'high';
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const ERROR_TEXT_LIMIT = 300;

const STATUE_PROMPT =
  'Transform this person into a classical white marble bust statue. Head and shoulders only, ' +
  'single uniform matte marble material, no color, plain solid light gray background, ' +
  'front-facing, no text.';

const EXTENSION_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * Extracts a short error description from a failed OpenAI response.
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function describeFailure(res) {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Not JSON; fall through and return the raw text.
  }
  return text.slice(0, ERROR_TEXT_LIMIT);
}

/**
 * Turns a portrait photo into a white marble bust using the OpenAI Images edit endpoint.
 * @param {Buffer} imageBuffer PNG or JPEG bytes of the source photo
 * @param {'image/png' | 'image/jpeg'} [mimeType] format of imageBuffer
 * @returns {Promise<Buffer>} PNG bytes of the statue image
 */
export async function makeStatueImage(imageBuffer, mimeType = 'image/png') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new Error(`Unsupported input image type: ${mimeType}`);

  const form = new FormData();
  form.append('model', OPENAI_IMAGE_MODEL);
  form.append('prompt', STATUE_PROMPT);
  form.append('size', OUTPUT_SIZE);
  form.append('input_fidelity', INPUT_FIDELITY);
  form.append('image', new Blob([imageBuffer], { type: mimeType }), `input.${extension}`);

  const res = await fetch(OPENAI_EDIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenAI image edit failed (${res.status}): ${await describeFailure(res)}`);
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI response did not contain image data');
  return Buffer.from(b64, 'base64');
}
