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
const nextPath = () => {
  const wanted = new URLSearchParams(location.search).get('next') ?? '/';
  return wanted.startsWith('/') && !wanted.startsWith('//') ? wanted : '/';
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

// Nobody has been created yet - say so, rather than leaving somebody guessing
// at a password that does not exist.
fetch('/api/auth/state')
  .then((response) => (response.ok ? response.json() : null))
  .then((payload) => {
    if (!payload?.empty) return;
    note.textContent =
      'No accounts exist yet. Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment and restart the server to create the first administrator.';
    note.hidden = false;
  })
  .catch(() => {});

username.focus();
