/**
 * Sign in.
 *
 * The reply sets an httpOnly cookie, which is the point: the token is never
 * readable from JavaScript, so a script injected into the dashboard cannot
 * carry it off. Nothing is kept in localStorage.
 */

const $ = (id) => document.getElementById(id);

const form = $('login-form');
const username = $('login-username');
const password = $('login-password');
const submit = $('login-submit');
const error = $('login-error');
const note = $('login-note');

const fail = (message) => {
  error.textContent = message;
  error.hidden = false;
  submit.disabled = false;
  submit.textContent = 'Sign in';
  password.select();
};

// Where to go back to, if something bounced us here. Same-origin paths only:
// an open redirect is a phishing gift, and this is exactly where one would go.
//
// Parsed rather than string-tested, because the string tests were wrong twice
// over. `startsWith('/') && !startsWith('//')` admits `/\evil.com`, which
// `location.assign` then resolves to http://evil.com/ - the URL parser treats a
// backslash as a slash for http and https. Asking the parser is the only way to
// be right here, because it is the same parser that will perform the navigation.
//
// And what is returned is the parser's own serialisation, never the raw string:
// `/a\r\nX: 1` also survives an origin check, since CR and LF are stripped from
// the path but only after the origin has been computed. Handing that back to a
// caller who puts it in a header is how a redirect becomes a header injection.
const nextPath = () => {
  const wanted = new URLSearchParams(location.search).get('next') ?? '/';
  try {
    const url = new URL(wanted, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  submit.textContent = 'Signing in...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      fail(payload?.error?.message ?? `Could not sign in (HTTP ${response.status}).`);
      return;
    }

    location.assign(nextPath());
  } catch {
    fail('The server did not answer. Is it still running?');
  }
});

/*
 * Why a sign-in bounced, said in words rather than a code.
 *
 * The Discord routes cannot answer with JSON - they are navigations, and the
 * browser is following a redirect - so they carry the reason in `?e=`. Each one
 * ends by saying the password box still works, because that is the thing a
 * person needs to know at 3am when Discord is the half that is broken.
 */
const REASONS = {
  expired: 'That sign-in took too long or was already used. Press the button again.',
  cancelled: 'Discord sign-in was cancelled.',
  norole: 'Your Discord account does not have the role this server requires.',
  disabled: 'That account has been switched off. Ask an administrator.',
  nosignup: 'Discord sign-in is limited to accounts that already exist here.',
  noname: 'Could not make an account from that Discord name. Ask an administrator to make you one.',
  busy: 'The server is finishing other sign-ins. Try again in a moment.',
  misconfigured: "This server's Discord sign-in is not set up correctly. Tell an administrator.",
  unavailable: 'Discord did not answer. Try again in a minute.',
  start: 'Start a Discord sign-in from this page rather than from a link.',
};

const reason = new URLSearchParams(location.search).get('e');
if (reason && REASONS[reason]) {
  error.textContent = `${REASONS[reason]} Your password still works - sign in above.`;
  error.hidden = false;
}

fetch('/api/auth/state')
  .then((response) => (response.ok ? response.json() : null))
  .then((payload) => {
    if (!payload) return;

    if (payload.discord) {
      const button = document.getElementById('login-discord');
      const label = document.getElementById('login-discord-label');
      // The destination rides on the link, and it goes through the same guard
      // the form uses - a second entry point must not be the one that reopens
      // the hole nextPath exists to close.
      button.href = `/api/auth/discord/start?next=${encodeURIComponent(nextPath())}`;
      if (payload.discord.role) label.textContent = `Continue with Discord`;
      button.title = `Requires ${payload.discord.role} in the Discord server`;
      button.hidden = false;
    }

    // Nobody has been created yet - say so, rather than leaving somebody
    // guessing at a password that does not exist. Three states, not two: on a
    // server where Discord can make accounts, the button below is the door and
    // telling somebody to go and edit an .env file would be wrong.
    if (!payload.empty) return;
    note.textContent = payload.discord?.signup
      ? `No accounts exist yet. Anyone with ${payload.discord.role} in the Discord server can sign in below and will get one. For an administrator, set ADMIN_USERNAME and ADMIN_PASSWORD and restart.`
      : 'No accounts exist yet. Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment and restart the server to create the first administrator.';
    note.hidden = false;
  })
  .catch(() => {});

username.focus();
