const OPENAI_EDIT_URL = 'https://api.openai.com/v1/images/edits';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5';
const OUTPUT_SIZE = '1024x1024';
const INPUT_FIDELITY = 'high';
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const SCENE_TIMEOUT_MS = 5 * 60 * 1000;
const ERROR_TEXT_LIMIT = 300;

const STATUE_PROMPT =
  'Transform this person into a classical white marble bust statue. Head and shoulders only, ' +
  'single uniform matte marble material, no color, plain solid light gray background, ' +
  'front-facing, no text.';

const LEGO_PROMPT =
  'Turn this person into a LEGO minifigure. Keep their hairstyle, hair color, facial hair, ' +
  'glasses, skin tone and clothing colors, with a printed minifigure face. Full body, ' +
  'standing straight, arms at the sides, front view, plain solid light gray background, ' +
  'no text, no logos.';

const EXTENSION_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const SCENE_PROMPT =
  'You are a model maker who builds 3D-printable figures out of simple solid shapes. ' +
  'Look at the LEGO minifigure in the image and model it: the cylindrical head with the stud ' +
  'on top, its hair piece, hat or helmet, the trapezoid torso, the arms and C-shaped hands, ' +
  'the hips and legs, standing on a thin round base plate. Match the proportions of a real ' +
  'minifigure and add the distinctive details (hair shape, glasses, beard, collar, hood). ' +
  'Use 20 to 100 parts. Units are millimetres, Z points up, the base plate sits on z = 0 and ' +
  'the figure is about 100 mm tall, centered on x = 0, y = 0, facing -Y. Parts must overlap ' +
  'so the model is one connected solid with nothing floating, and nothing may hang lower than ' +
  'the base plate.\n\n' +
  'Shapes (each is placed at center, sized, then rotated by rotation in degrees around X, ' +
  'then Y, then Z):\n' +
  '- ellipsoid: size is the full diameter along x, y, z.\n' +
  '- box: size is the full width, depth and height.\n' +
  '- cylinder: axis along Z, size.x and size.y are the bottom diameters, size.z the height; ' +
  'top_scale scales the top face (1 = cylinder, 0 = cone).\n' +
  '- torus: lies in the XY plane, size.x and size.y are the outer diameters, size.z the tube ' +
  'thickness.\n' +
  'Set top_scale to 1 for shapes other than cylinder.';

const VECTOR_SCHEMA = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
};

/** JSON schema the model must follow; see lib/mesh.js for how each shape is built. */
const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          shape: { type: 'string', enum: ['ellipsoid', 'box', 'cylinder', 'torus'] },
          center: VECTOR_SCHEMA,
          size: VECTOR_SCHEMA,
          rotation: VECTOR_SCHEMA,
          top_scale: { type: 'number' },
        },
        required: ['label', 'shape', 'center', 'size', 'rotation', 'top_scale'],
        additionalProperties: false,
      },
    },
  },
  required: ['parts'],
  additionalProperties: false,
};

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
 * Restyles a portrait photo with the OpenAI Images edit endpoint.
 * @param {Buffer} imageBuffer PNG or JPEG bytes of the source photo
 * @param {'image/png' | 'image/jpeg'} mimeType format of imageBuffer
 * @param {string} prompt
 * @returns {Promise<Buffer>} PNG bytes of the restyled image
 */
async function editImage(imageBuffer, mimeType, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new Error(`Unsupported input image type: ${mimeType}`);

  const form = new FormData();
  form.append('model', OPENAI_IMAGE_MODEL);
  form.append('prompt', prompt);
  form.append('size', OUTPUT_SIZE);
  form.append('input_fidelity', INPUT_FIDELITY);
  form.append('image', new Blob([imageBuffer], { type: mimeType }), `input.${extension}`);

  const res = await fetch(OPENAI_EDIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenAI image edit failed (${res.status}): ${await describeFailure(res)}`);
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI response did not contain image data');
  return Buffer.from(b64, 'base64');
}

/**
 * Turns a portrait photo into a white marble bust.
 * @param {Buffer} imageBuffer PNG or JPEG bytes of the source photo
 * @param {'image/png' | 'image/jpeg'} mimeType format of imageBuffer
 * @returns {Promise<Buffer>} PNG bytes of the statue image
 */
export function makeStatueImage(imageBuffer, mimeType) {
  return editImage(imageBuffer, mimeType, STATUE_PROMPT);
}

/**
 * Turns a portrait photo into a LEGO minifigure.
 * @param {Buffer} imageBuffer PNG or JPEG bytes of the source photo
 * @param {'image/png' | 'image/jpeg'} mimeType format of imageBuffer
 * @returns {Promise<Buffer>} PNG bytes of the minifigure image
 */
export function makeLegoImage(imageBuffer, mimeType) {
  return editImage(imageBuffer, mimeType, LEGO_PROMPT);
}

/**
 * Asks a GPT vision model to rebuild the minifigure in the image out of solid shapes.
 * @param {Buffer} pngBuffer PNG bytes of the minifigure image
 * @returns {Promise<{ parts: object[] }>} the scene, ready for sceneToStl()
 */
export async function makeFigureScene(pngBuffer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SCENE_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Build this minifigure.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBuffer.toString('base64')}` } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'figure', strict: true, schema: SCENE_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(SCENE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenAI request failed (${res.status}): ${await describeFailure(res)}`);
  }
  const message = (await res.json())?.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`OpenAI declined: ${message.refusal}`);
  if (!message?.content) throw new Error('OpenAI response did not contain a model');
  return JSON.parse(message.content);
}
