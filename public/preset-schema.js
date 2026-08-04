/**
 * What a "preset" is: every styling knob on the graphic, in one ordered list.
 *
 * Everything that touches presets reads this file - the server sanitises
 * against it, the dashboard builds its Style panel from it, and the share-code
 * codec walks it in order. Adding a styling option here is the only edit
 * required for it to appear in all three.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

export const FONT_CHOICES = ['Gabarito', 'Poppins', 'Inter', 'Arial', 'Impact', 'Oswald', 'Tungsten', 'DIN'];

/**
 * type: hex     - a colour, always present
 *       hexOff  - a colour that may be empty, meaning "off"/transparent
 *       ratio   - 0..1
 *       bool    - a toggle
 *       font    - one of FONT_CHOICES
 */
export const PRESET_FIELDS = [
  { key: 'font', type: 'font', group: 'Typeface', label: 'Font' },

  { key: 'leftBg', type: 'hex', group: 'Left side', label: 'Background' },
  { key: 'leftBigText', type: 'hex', group: 'Left side', label: 'Primary text' },
  { key: 'leftSmallText', type: 'hex', group: 'Left side', label: 'Secondary text' },

  { key: 'rightBg', type: 'hex', group: 'Right side', label: 'Background' },
  { key: 'rightBigText', type: 'hex', group: 'Right side', label: 'Primary text' },
  { key: 'rightSmallText', type: 'hex', group: 'Right side', label: 'Secondary text' },

  { key: 'globalText', type: 'hex', group: 'MVP panel and centre', label: 'Centre / stat text' },
  { key: 'mvpBannerBg', type: 'hex', group: 'MVP panel and centre', label: 'MVP banner fill' },
  { key: 'mvpBannerText', type: 'hex', group: 'MVP panel and centre', label: 'MVP banner text' },
  { key: 'mvpName', type: 'hex', group: 'MVP panel and centre', label: 'MVP player name' },
  { key: 'mvpAgent', type: 'hex', group: 'MVP panel and centre', label: 'MVP agent name' },

  { key: 'panelOpacity', type: 'ratio', group: 'Panels', label: 'Dark panel opacity' },
  { key: 'pageBackground', type: 'hexOff', group: 'Panels', label: 'Solid page background' },

  { key: 'uppercase', type: 'bool', group: 'Options', label: 'Uppercase all text' },
  { key: 'showMvpPortrait', type: 'bool', group: 'Options', label: 'Show MVP agent portrait' },
  { key: 'showRoleIcon', type: 'bool', group: 'Options', label: 'Show agent role icons' },
];

export const PRESET_KEYS = PRESET_FIELDS.map((field) => field.key);

/** Field groups in declaration order, for building the editor. */
export const PRESET_GROUPS = [...new Set(PRESET_FIELDS.map((field) => field.group))];

// -------------------------------------------------------------- built-ins ---

/**
 * Shipped looks. These are code, not data: they cannot be deleted or edited,
 * so an operator always has something known-good to fall back to mid-broadcast.
 */
export const BUILT_IN_PRESETS = [
  {
    id: 'riotline',
    name: 'Riotline',
    preset: {
      font: 'Gabarito',
      leftBg: '#21597a',
      leftBigText: '#131313',
      leftSmallText: '#30a4e7',
      rightBg: '#131313',
      rightBigText: '#ff3434',
      rightSmallText: '#ffffff',
      globalText: '#30a4e7',
      mvpBannerBg: '#db3131',
      mvpBannerText: '#131313',
      mvpName: '#5ad4e4',
      mvpAgent: '#ffffff',
      panelOpacity: 0.45,
      pageBackground: '',
      uppercase: true,
      showMvpPortrait: true,
      showRoleIcon: true,
    },
  },
  {
    id: 'sides',
    name: 'Attack / Defence',
    preset: {
      font: 'Gabarito',
      leftBg: '#a32833',
      leftBigText: '#ffffff',
      leftSmallText: '#ffb3ba',
      rightBg: '#14526b',
      rightBigText: '#ffffff',
      rightSmallText: '#8fd8ea',
      globalText: '#ece8e1',
      mvpBannerBg: '#ff4655',
      mvpBannerText: '#0f1923',
      mvpName: '#ffffff',
      mvpAgent: '#ece8e1',
      panelOpacity: 0.5,
      pageBackground: '',
      uppercase: true,
      showMvpPortrait: true,
      showRoleIcon: true,
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    preset: {
      font: 'Poppins',
      leftBg: '#1b2838',
      leftBigText: '#ffffff',
      leftSmallText: '#7fd4ff',
      rightBg: '#10161f',
      rightBigText: '#ffffff',
      rightSmallText: '#7fd4ff',
      globalText: '#7fd4ff',
      mvpBannerBg: '#2f81f7',
      mvpBannerText: '#0d1117',
      mvpName: '#7fd4ff',
      mvpAgent: '#ffffff',
      panelOpacity: 0.55,
      pageBackground: '',
      uppercase: true,
      showMvpPortrait: true,
      showRoleIcon: true,
    },
  },
  {
    id: 'contrast',
    name: 'High contrast',
    preset: {
      font: 'Oswald',
      leftBg: '#000000',
      leftBigText: '#ffffff',
      leftSmallText: '#ffd400',
      rightBg: '#000000',
      rightBigText: '#ffffff',
      rightSmallText: '#ffd400',
      globalText: '#ffd400',
      mvpBannerBg: '#ffd400',
      mvpBannerText: '#000000',
      mvpName: '#ffd400',
      mvpAgent: '#ffffff',
      panelOpacity: 0.8,
      pageBackground: '',
      uppercase: true,
      showMvpPortrait: true,
      showRoleIcon: true,
    },
  },
  {
    id: 'mono',
    name: 'Mono',
    preset: {
      font: 'Inter',
      leftBg: '#f2f2f2',
      leftBigText: '#1a1a1a',
      leftSmallText: '#6b6b6b',
      rightBg: '#1a1a1a',
      rightBigText: '#f2f2f2',
      rightSmallText: '#9a9a9a',
      globalText: '#d0d0d0',
      mvpBannerBg: '#1a1a1a',
      mvpBannerText: '#f2f2f2',
      mvpName: '#ffffff',
      mvpAgent: '#d0d0d0',
      panelOpacity: 0.6,
      pageBackground: '',
      uppercase: true,
      showMvpPortrait: true,
      showRoleIcon: true,
    },
  },
];

export const BUILT_IN_IDS = new Set(BUILT_IN_PRESETS.map((entry) => entry.id));

// ------------------------------------------------------------ share codes ---

/**
 * A preset as one pasteable string, so a look can be handed to another operator
 * over chat without sharing a file.
 *
 * Positional rather than JSON: the field order above is the schema, which keeps
 * a code down to ~120 characters instead of ~700. The RLP1 tag is what makes
 * that safe - if the field list ever changes, old codes are rejected outright
 * rather than silently decoded into the wrong colours.
 */
const CODE_VERSION = 'RLP1';
const SEP = '~';
const EMPTY = '-';

const encodeValue = (field, value) => {
  switch (field.type) {
    case 'hex':
    case 'hexOff':
      return String(value ?? '').replace('#', '') || EMPTY;
    case 'ratio':
      return String(Math.round((Number(value) || 0) * 100));
    case 'bool':
      return value ? '1' : '0';
    default:
      return String(value ?? '').replace(new RegExp(SEP, 'g'), ' ');
  }
};

const decodeValue = (field, raw) => {
  switch (field.type) {
    case 'hex':
    case 'hexOff':
      return raw === EMPTY ? '' : `#${raw}`;
    case 'ratio':
      return (Number(raw) || 0) / 100;
    case 'bool':
      return raw === '1';
    default:
      return raw;
  }
};

export function encodePreset(name, preset) {
  const parts = [CODE_VERSION, String(name ?? '').replace(new RegExp(SEP, 'g'), ' ').slice(0, 40) || 'Preset'];
  for (const field of PRESET_FIELDS) parts.push(encodeValue(field, preset?.[field.key]));
  return parts.join(SEP);
}

/** @returns {{name: string, preset: object}|null} null for anything unparseable */
export function decodePreset(code) {
  const parts = String(code ?? '').trim().split(SEP);
  if (parts.length !== PRESET_FIELDS.length + 2) return null;
  if (parts[0] !== CODE_VERSION) return null;

  const preset = {};
  PRESET_FIELDS.forEach((field, index) => {
    preset[field.key] = decodeValue(field, parts[index + 2]);
  });

  // Values are still untrusted - the caller sanitises before use.
  return { name: parts[1], preset };
}
