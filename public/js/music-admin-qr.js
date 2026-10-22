/**
 * The QR codes section of the admin page (music-admin.html): makes codes that open a page of
 * the site with ?qr=<slug>, shows each code with its scans (counted by qr-track.js on the
 * pages, see supabase/migrations/), and saves it as SVG or PNG for print. Everything that comes
 * from the database goes on the page as text only.
 */

import { encodeQr, qrSvg, QUIET_ZONE } from './qr.js';

const $ = (id) => document.getElementById(id);
/** Pixels per module of a saved PNG: 37 modules of a typical link make a 1,320 px square. */
const PNG_MODULE_PX = 30;
const DAYS_SHOWN = 30;
const CHART_BAR_WIDTH = 6;
const CHART_HEIGHT = 32;
const SLUG_MAX = 40;
const PAGE_NAMES = { '': 'Music page', 'about.html': 'About page', 'spooky.html': 'From Failure to Fun', 'flakifier.html': 'Flakifier app' };

/** The site the links point at: the folder this admin page is in. */
const base = new URL('./', location.href);
base.search = '';
base.hash = '';

/** @type {(name: string, args?: object) => Promise<any>} */
let call;

/** The link a code holds. */
function linkFor({ slug, target }) {
  const url = new URL(target, base);
  url.searchParams.set('qr', slug);
  return url.href;
}

/** A short name from the description: "Poster at the Happylab!" becomes poster-at-the-happylab. */
const slugFrom = (text) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');

const fileName = (slug, extension) => `qr-${slug}.${extension}`;

/** Hands the browser a file to save. */
function save(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** The code as a PNG, drawn module by module so it stays sharp. */
function pngBlob(modules) {
  const canvas = document.createElement('canvas');
  const size = (modules.length + QUIET_ZONE * 2) * PNG_MODULE_PX;
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#000';
  modules.forEach((row, y) => row.forEach((on, x) => {
    if (on) context.fillRect((x + QUIET_ZONE) * PNG_MODULE_PX, (y + QUIET_ZONE) * PNG_MODULE_PX, PNG_MODULE_PX, PNG_MODULE_PX);
  }));
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

const dayName = (day) => new Date(day).toLocaleDateString([], { dateStyle: 'medium', timeZone: 'UTC' });

/** A bar for each of the last 30 days; each bar names its day and its scans on hover. */
function chart(days) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const most = Math.max(1, ...days.map((day) => day.scans));
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('class', 'qr-chart');
  svg.setAttribute('viewBox', `0 0 ${days.length * CHART_BAR_WIDTH} ${CHART_HEIGHT}`);
  // The bars stretch to the width the page gives them.
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  const total = days.reduce((sum, day) => sum + day.scans, 0);
  svg.setAttribute('aria-label', `${plural(total, 'scan')} in the last ${DAYS_SHOWN} days, at most ${most} on one day.`);
  for (const [i, day] of days.entries()) {
    const bar = document.createElementNS(svgNs, 'rect');
    // At least a sliver, so an empty day still reads as a day.
    const height = Math.max(1, (day.scans / most) * CHART_HEIGHT);
    bar.setAttribute('x', String(i * CHART_BAR_WIDTH + 1));
    bar.setAttribute('width', String(CHART_BAR_WIDTH - 2));
    bar.setAttribute('y', String(CHART_HEIGHT - height));
    bar.setAttribute('height', String(height));
    if (day.scans === 0) bar.setAttribute('class', 'qr-chart-empty');
    const title = document.createElementNS(svgNs, 'title');
    title.textContent = `${dayName(day.day)}: ${plural(day.scans, 'scan')}`;
    bar.append(title);
    svg.append(bar);
  }
  return svg;
}

/**
 * The chart's numbers as text, for keyboards and screen readers, which cannot reach the bars'
 * hover titles: the days with scans, newest first. Null when there were none.
 */
function dayList(days) {
  const busy = days.filter((day) => day.scans > 0).reverse();
  if (busy.length === 0) return null;
  const details = document.createElement('details');
  details.className = 'qr-days';
  const summary = document.createElement('summary');
  summary.textContent = `Scans by day (UTC): ${plural(busy.length, 'day')} with scans`;
  const list = document.createElement('ul');
  list.replaceChildren(...busy.map((day) => {
    const item = document.createElement('li');
    item.textContent = `${dayName(day.day)}: ${plural(day.scans, 'scan')}`;
    return item;
  }));
  const note = document.createElement('p');
  note.textContent = `The other days of the last ${DAYS_SHOWN} had none.`;
  details.append(summary, list, note);
  return details;
}

function button(text, label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'admin-button';
  element.textContent = text;
  if (label) element.setAttribute('aria-label', label);
  element.addEventListener('click', onClick);
  return element;
}

/** One code: the image, its link, its scans, and what can be done with it. */
function renderCode(code) {
  const link = linkFor(code);
  const modules = encodeQr(link);
  const svg = qrSvg(modules, { title: code.label || code.slug });
  const name = code.label || code.slug;

  const item = document.createElement('li');
  item.className = 'admin-ballot qr-code';
  const image = document.createElement('img');
  image.className = 'qr-image';
  image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  image.width = image.height = 128;
  image.alt = `QR code for ${link}`;

  const body = document.createElement('div');
  body.className = 'qr-body';
  const head = document.createElement('div');
  head.className = 'admin-ballot-head';
  const title = document.createElement('strong');
  title.textContent = name;
  const meta = document.createElement('span');
  meta.className = 'helper';
  const made = new Date(code.created_at).toLocaleDateString([], { dateStyle: 'medium' });
  meta.textContent = `${PAGE_NAMES[code.target] ?? code.target} · made ${made}`;
  head.append(title, meta);

  const anchor = document.createElement('a');
  anchor.className = 'qr-link';
  anchor.href = link;
  anchor.textContent = link;

  const stats = document.createElement('p');
  stats.className = 'admin-ballot-points';
  const last = code.last ? `, the last ${new Date(code.last).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  stats.textContent = `${plural(code.scans, 'scan')}, ${code.week.toLocaleString()} in the last 7 days${last}.`;
  const countries = document.createElement('p');
  countries.className = 'admin-ballot-points';
  countries.textContent = code.countries.length === 0 ? ''
    : `From: ${code.countries.map((c) => `${c.country ?? 'unknown'} ${c.scans.toLocaleString()}`).join(' · ')}`;

  const actions = document.createElement('div');
  actions.className = 'admin-bar qr-actions';
  const copy = button('Copy link', `Copy the link of ${name}`, async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
  });
  const remove = button('Delete', `Delete the code ${name}`, () => deleteCode(code, remove));
  remove.classList.add('admin-delete');
  actions.append(
    button('SVG', `Save ${name} as SVG, for print`, () => save(new Blob([svg], { type: 'image/svg+xml' }), fileName(code.slug, 'svg'))),
    button('PNG', `Save ${name} as PNG`, async () => save(await pngBlob(modules), fileName(code.slug, 'png'))),
    copy,
    remove,
  );

  body.append(...[head, anchor, stats, chart(code.days), dayList(code.days), countries, actions].filter(Boolean));
  item.append(image, body);
  return item;
}

/** Loads the codes and their scans, and shows them. */
export async function loadQrCodes() {
  $('qr-list-status').textContent = 'Loading…';
  try {
    const codes = await call('admin_qr_links');
    $('qr-list-status').textContent = '';
    const scans = codes.reduce((sum, code) => sum + code.scans, 0);
    $('qr-count').textContent = codes.length === 0 ? 'No codes yet.'
      : `${plural(codes.length, 'code')}, ${plural(scans, 'scan')} in all.`;
    $('qr-list').replaceChildren(...codes.map(renderCode));
  } catch (error) {
    $('qr-list-status').textContent = error.message;
  }
}

async function deleteCode(code, button) {
  const name = code.label || code.slug;
  if (!confirm(`Delete the code ${name} and its ${plural(code.scans, 'scan')}? Printed copies still open the page, but are no longer counted.`)) return;
  button.disabled = true;
  let message;
  try {
    await call('admin_delete_qr_link', { slug: code.slug });
    message = `Deleted the code ${name}.`;
  } catch (error) {
    message = error.message;
  }
  // The list first, as loading it clears the line the message goes on.
  await loadQrCodes();
  $('qr-list-status').textContent = message;
}

/**
 * Sets up the section.
 * @param {(name: string, args?: object) => Promise<any>} callAdmin calls an admin function,
 *   throwing the message to show when it fails
 */
export function setUpQrCodes(callAdmin) {
  call = callAdmin;
  const preview = /(^|\.)localhost$|^127\./.test(base.hostname) || base.pathname.includes('/pr-preview/');
  $('qr-base').textContent = `The codes link to ${base.href}.${preview ? ' That is a preview or a local copy: make codes for print on the main site, so they keep working.' : ''}`;

  $('qr-label').addEventListener('input', () => {
    if (!$('qr-slug').dataset.edited) $('qr-slug').value = slugFrom($('qr-label').value);
  });
  $('qr-slug').addEventListener('input', () => {
    $('qr-slug').dataset.edited = $('qr-slug').value ? 'true' : '';
  });

  $('qr-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = $('qr-label').value.trim();
    const slug = $('qr-slug').value.trim();
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) {
      $('qr-status').textContent = 'Give it a short name: lower-case letters, digits and dashes.';
      return;
    }
    const submit = event.submitter;
    submit.disabled = true;
    try {
      await call('admin_add_qr_link', { slug, label, target: $('qr-target').value });
      $('qr-status').textContent = `Made the code ${label || slug}.`;
      $('qr-form').reset();
      delete $('qr-slug').dataset.edited;
      await loadQrCodes();
    } catch (error) {
      $('qr-status').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  $('qr-refresh').addEventListener('click', loadQrCodes);
}
