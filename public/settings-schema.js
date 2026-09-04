/**
 * Server-wide switches an administrator can throw.
 *
 * Not per-session. These decide what the *machine* does - whether it drives a
 * browser at tracker.gg, whether it will run a ten-account poll - so one
 * operator turning one off on their own dashboard would be meaningless.
 *
 * Defined once here and imported by both sides, like every other field in this
 * project: the server sanitises against this list, the admin panel renders from
 * it, and adding a third switch is one entry rather than three edits that can
 * drift apart.
 *
 * `requires` names a capability the environment has to provide first. A switch
 * whose requirement is missing is shown as unavailable rather than merely off,
 * because "the administrator turned this off" and "this deployment cannot do
 * it at all" are different answers to the same question, and an operator
 * looking at a greyed-out control deserves to know which one they are seeing.
 */

export const SETTING_FIELDS = [
  {
    key: 'tracker',
    label: 'tracker.gg as a data source',
    default: true,
    requires: 'tracker',
    help:
      'Drives a real Chrome on this machine to read the tracker.gg website. It is the ' +
      'fallback when HenrikDev has not indexed a custom game. Turning it off closes that ' +
      'browser, removes the source from the lookup tab, and disables the Cloudflare login ' +
      'panel. HenrikDev and the Riot API are unaffected.',
    off: 'Lookups against tracker.gg are refused and the browser is not kept running.',
    missing:
      'TRACKER_ENABLED is not set in the environment, so this deployment has no tracker ' +
      'browser to switch on. Set it and restart the server.',
  },
  {
    key: 'discord',
    label: 'Signing in with Discord',
    default: true,
    requires: 'discord',
    help:
      'Lets anyone holding the configured Discord role sign in, and makes an account for ' +
      'them if they have none. Turning it off hides the button, refuses the two Discord ' +
      'routes and stops anyone linking an account - without touching the credentials, so ' +
      'it can be turned straight back on. Existing sessions are not ended; use Disable on ' +
      'an account for that. Password sign-in is unaffected.',
    off: 'The button is hidden and both Discord routes answer as though they do not exist.',
    missing:
      'This deployment has no Discord application configured, so there is nothing to switch ' +
      'on. Set DISCORD_ENABLED and the five values beside it in the environment, then ' +
      'restart the server. The boot banner names whichever one is missing.',
  },
  {
    key: 'watch',
    label: 'Post-match lookup across several accounts',
    default: true,
    help:
      'Watches up to ten Riot IDs at once and takes the scoreboard from whichever account ' +
      'publishes it first. It is the fastest way to get a custom on air, and it is also ' +
      'the heaviest thing this server does - five lookups per check, each one a browser ' +
      'tab when the source is tracker.gg.',
    off: 'The panel is hidden and the server refuses a watch lookup.',
  },
];

export const SETTING_KEYS = SETTING_FIELDS.map((field) => field.key);

export const DEFAULT_SETTINGS = {
  version: 1,
  ...Object.fromEntries(SETTING_FIELDS.map((field) => [field.key, field.default])),
};

/**
 * Missing means the default, not false.
 *
 * A settings.json written before a switch existed must not read as "the
 * administrator turned this off" - a new feature arriving switched off on every
 * server that upgrades is the kind of surprise nobody thanks you for.
 */
export function sanitiseSettings(source, fallback = DEFAULT_SETTINGS) {
  const from = source && typeof source === 'object' ? source : {};
  return {
    version: 1,
    ...Object.fromEntries(
      SETTING_FIELDS.map((field) => [
        field.key,
        typeof from[field.key] === 'boolean' ? from[field.key] : (fallback[field.key] ?? field.default),
      ]),
    ),
  };
}
