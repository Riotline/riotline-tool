/**
 * The upload-or-paste media control, shared by every dashboard.
 *
 * Drop a file on it, browse for one, or paste a URL. All three end up as the
 * same string - an upload is just a URL that happens to be served out of
 * .state/media, which is why there is no second "uploaded vs pasted" concept
 * anywhere downstream of here.
 *
 * It lives on its own because three dashboards need it against four different
 * objects: the winner graphic's state, the agent select state, the team
 * library's draft, and the music bed. Accessors rather than a path is what lets
 * one control serve all of them.
 */

import { el } from './fields.js';
import { api } from './session.js';

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

/**
 * @param {string} label
 * @param {() => string} get
 * @param {(value: string) => void} set
 */
export function mediaControl(label, get, set, { accept = 'image/*', placeholder = 'https://... or drop a file here' } = {}) {
  const isAudio = accept.startsWith('audio');

  const preview = el('div', `logo-preview${isAudio ? ' is-audio' : ''}`);
  const image = el('img', null, { alt: '' });
  if (!isAudio) preview.append(image);

  const url = el('input', null, {
    type: 'text',
    spellcheck: 'false',
    placeholder,
    maxlength: 500,
  });

  // An audio file has no thumbnail, so its box just reports whether one is set.
  const showThumb = (value) => {
    if (!isAudio) {
      image.hidden = !value;
      if (value) image.src = value;
      else image.removeAttribute('src');
    }
    preview.classList.toggle('is-empty', !value);
  };

  const paint = () => {
    url.value = get() ?? '';
    showThumb(url.value);
  };

  // Typing writes through but does not repaint the box the operator is in -
  // only the thumbnail needs to follow along.
  url.addEventListener('input', () => {
    set(url.value);
    showThumb(url.value);
  });

  const upload = async (file) => {
    if (!file) return;
    try {
      // No multipart envelope: one file per request, so the body is the file.
      //
      // The type is declared rather than left to the browser, and it is a lie
      // on purpose - the server sniffs the format out of the bytes and ignores
      // this entirely. What it is for is the CSRF check, which refuses a write
      // whose Content-Type an HTML form could have produced. A file dropped
      // from a folder the OS has no type for would otherwise arrive with no
      // Content-Type at all, and be refused.
      const response = await fetch(api('/api/media'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      set(payload.url);
      paint();
      toast(`Uploaded ${file.name}`);
    } catch (error) {
      toast(`Logo not uploaded: ${error.message}`);
    }
  };

  const picker = el('input', 'logo-file', { type: 'file', accept });
  picker.addEventListener('change', () => {
    void upload(picker.files?.[0]);
    // Cleared so re-picking the same file still fires a change event.
    picker.value = '';
  });

  const browse = el('button', 'mini-btn', { type: 'button' }, 'Upload');
  browse.addEventListener('click', () => picker.click());

  const clear = el('button', 'mini-btn', { type: 'button', title: 'Remove it' }, 'Clear');
  clear.addEventListener('click', () => {
    set('');
    paint();
  });

  // Dropping onto the thumbnail is the fast path; the button is there because a
  // drop target with no visible affordance is a feature nobody finds.
  preview.addEventListener('dragover', (event) => {
    event.preventDefault();
    preview.classList.add('is-over');
  });
  preview.addEventListener('dragleave', () => preview.classList.remove('is-over'));
  preview.addEventListener('drop', (event) => {
    event.preventDefault();
    preview.classList.remove('is-over');
    void upload(event.dataTransfer?.files?.[0]);
  });

  const tools = el('div', 'logo-tools');
  tools.append(browse, clear, picker);

  const body = el('div', 'logo-body');
  body.append(url, tools);

  const row = el('div', 'logo-row');
  row.append(preview, body);
  paint();

  const wrap = el('div', 'g-field');
  wrap.append(el('span', null, {}, label), row);
  return wrap;
}
