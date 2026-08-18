/**
 * The editor controls both dashboards are built from.
 *
 * Every control does the same three things - read a dotted path out of some
 * state object, write the edited value back, and say that something changed -
 * so the only thing that varies between the scoreboard editor and the winner
 * editor is which state object and which save function. That is what
 * `makeFields` is closing over.
 *
 * The closures read the accessors on every call rather than capturing a state
 * object, so a dashboard that replaces its state wholesale (adopting the
 * server's sanitised copy after a save, say) does not leave stale controls
 * writing into an object nobody is looking at any more.
 *
 * Dependency-free, DOM-only.
 */

export function el(tag, className, attrs = {}, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export const readPath = (source, path) =>
  path.split('.').reduce((value, part) => (value === null || value === undefined ? value : value[part]), source);

export function writePath(target, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const host = parts.reduce((value, part) => value[part], target);
  host[last] = value;
}

export const grid = (columns, children) => {
  const node = el('div', `field-grid${columns ? ` cols-${columns}` : ''}`);
  node.append(...children);
  return node;
};

export const title = (text, extra) => {
  const node = el('h2', 'panel-title', {}, text);
  if (extra) node.append(extra);
  return node;
};

export const subhead = (text) => el('div', 'subhead', {}, text);

export const help = (text) => el('p', 'field-help', {}, text);

/** The server stores image URLs up to 500 characters; the inputs must match. */
const URL_MAX = 500;
const USABLE_URL = /^(?:https?:\/\/\S+|\/[\w./-]*)$/i;

export function field(label, input) {
  const wrap = el('label', 'g-field');
  wrap.append(el('span', null, {}, label), input);
  return wrap;
}

/**
 * @param {() => object} state the object the paths below are relative to
 * @param {() => void} onChange called after every edit - normally a queued save
 */
export function makeFields(state, onChange) {
  const get = (path) => readPath(state(), path);
  const set = (path, value) => {
    writePath(state(), path, value);
    onChange();
  };

  /** Text/URL input bound to a dotted path in the state. */
  function textField(label, path, { placeholder = '', maxlength = 120 } = {}) {
    const input = el('input', null, { type: 'text', spellcheck: 'false', placeholder, maxlength });
    input.value = get(path) ?? '';
    input.addEventListener('input', () => set(path, input.value));
    return field(label, input);
  }

  /**
   * A text field holding an image URL.
   *
   * Two things it does that a plain text field must not. The length cap matches
   * what the server actually stores - the 120 of a normal text field silently
   * truncates a CDN link, which then parses as a perfectly valid URL pointing
   * nowhere, so the image never appears and the field looks like it refused to
   * save. Measured against a real Discord attachment link: 181 characters, cut
   * mid-signature.
   *
   * And it says so when the value cannot survive sanitising. Anything that is
   * not http(s) or a path starting with / is discarded server-side, which
   * without a mark here is indistinguishable from the save failing.
   */
  function urlField(label, path, { placeholder = '' } = {}) {
    const wrap = textField(label, path, { placeholder, maxlength: URL_MAX });
    const input = wrap.querySelector('input');

    const mark = () => {
      const value = input.value.trim();
      const usable = !value || USABLE_URL.test(value);
      input.classList.toggle('invalid', !usable);
      input.title = usable
        ? ''
        : 'Must start with https://, http:// or / - anything else is discarded when the graphic saves.';
    };

    input.addEventListener('input', mark);
    mark();
    return wrap;
  }

  function numberField(label, path, { min = 0, max = 999 } = {}) {
    const input = el('input', null, { type: 'number', min, max, step: '1' });
    input.value = String(get(path) ?? 0);
    input.addEventListener('input', () => {
      // A cleared box means zero, not "keep the old number" - otherwise the
      // graphic silently keeps a stale score while the field looks empty.
      const parsed = Number.parseInt(input.value, 10);
      set(path, Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0);
    });
    return field(label, input);
  }

  /**
   * A select over {key, label} options. Unlike selectField there is no blank
   * entry: these fields always hold one of the listed values.
   */
  function choiceField(label, path, options) {
    const select = el('select');
    for (const option of options) select.append(el('option', null, { value: option.key }, option.label));
    select.value = String(get(path) ?? '');
    select.addEventListener('change', () => set(path, select.value));
    return field(label, select);
  }

  /** A select over plain strings, with a blank "none" entry. */
  function selectField(label, path, options, { allowUnknown = true, none = '- none -' } = {}) {
    const select = el('select');
    const current = String(get(path) ?? '');
    const values = options.includes(current) || !current || !allowUnknown ? options : [current, ...options];

    select.append(el('option', null, { value: '' }, none));
    for (const value of values) select.append(el('option', null, { value }, value));
    select.value = current;

    select.addEventListener('change', () => set(path, select.value));
    return field(label, select);
  }

  function colourField(label, path) {
    const input = el('input', null, { type: 'color' });
    input.value = get(path) || '#000000';
    input.addEventListener('input', () => set(path, input.value));
    return field(label, input);
  }

  function checkField(label, path) {
    const input = el('input', null, { type: 'checkbox' });
    input.checked = Boolean(get(path));
    input.addEventListener('change', () => set(path, input.checked));
    const wrap = el('label', 'checkline');
    wrap.append(input, el('span', null, {}, label));
    return wrap;
  }

  function rangeField(label, path, { min = 0, max = 1, step = 0.05 } = {}) {
    const input = el('input', null, { type: 'range', min, max, step });
    input.value = String(get(path) ?? 0);
    input.addEventListener('input', () => set(path, Number.parseFloat(input.value)));
    return field(label, input);
  }

  /**
   * A colour that can be switched off entirely - blank means transparent, which
   * is what an OBS source wants for a page background.
   */
  function optionalColourField(label, path) {
    const toggle = el('input', null, { type: 'checkbox' });
    const picker = el('input', null, { type: 'color' });

    const current = get(path);
    toggle.checked = Boolean(current);
    picker.value = current || '#000000';
    picker.disabled = !toggle.checked;

    const push = () => {
      picker.disabled = !toggle.checked;
      set(path, toggle.checked ? picker.value : '');
    };

    toggle.addEventListener('change', push);
    picker.addEventListener('input', push);

    const line = el('label', 'checkline');
    line.append(toggle, el('span', null, {}, label));

    const wrap = el('div', 'g-field');
    wrap.append(line, picker);
    return wrap;
  }

  return {
    get,
    set,
    textField,
    urlField,
    numberField,
    choiceField,
    selectField,
    colourField,
    checkField,
    rangeField,
    optionalColourField,
  };
}
