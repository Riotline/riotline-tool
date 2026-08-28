/**
 * Account, access and administration.
 *
 * Three jobs that share one fetch of /api/account/me, which is why they are one
 * module rather than three:
 *
 *   the topbar   who is signed in, and whose production is on screen
 *   Account tab  your password, your OBS key, and who you have let in
 *   Admin tab    other people's accounts - admins only
 *
 * Nothing here writes a graphic, so it has no state to keep in step and no
 * stream to subscribe to. Everything is a request and a repaint.
 */

import { el } from './fields.js';
import { SETTING_FIELDS } from './settings-schema.js';
import { SESSION_ID, account, refreshAccount, switchTo } from './session.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  whoami: $('whoami'),
  whoamiUser: $('whoami-user'),
  target: $('session-target'),
  adminTab: document.querySelector('.tab[data-tab="admin"]'),

  facts: $('account-facts'),
  current: $('acc-current'),
  fresh: $('acc-new'),
  again: $('acc-again'),
  savePassword: $('acc-save'),
  note: $('acc-note'),

  key: $('acc-key'),
  copyKey: $('acc-copy-key'),
  rotate: $('acc-rotate'),
  grants: $('acc-grants'),

  admUsername: $('adm-username'),
  admPassword: $('adm-password'),
  admIsAdmin: $('adm-admin'),
  admCreate: $('adm-create'),
  admNote: $('adm-note'),
  admUsers: $('adm-users'),
  admSettings: $('adm-settings'),
  admHealth: $('adm-health'),
  admRefresh: $('adm-refresh'),

  logView: $('adm-log'),
  logLevel: $('adm-log-level'),
  logFollow: $('adm-log-follow'),
  logFilter: $('adm-log-filter'),
  logCount: $('adm-log-count'),
  logCopy: $('adm-log-copy'),
};

let me = null;

/** Every write on this tab is the same shape, so the error handling is written once. */
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload?.error?.message ?? `Request failed (HTTP ${response.status}).`);
  }
  return payload;
}

const when = (stamp) => (stamp ? new Date(stamp).toLocaleString() : 'never');

function facts(target, rows) {
  target.replaceChildren(
    ...rows.flatMap(([label, value]) => [el('dt', null, {}, label), el('dd', null, {}, String(value))]),
  );
}

// ---------------------------------------------------------------- topbar ---

/**
 * The production selector, and the warning that goes with it.
 *
 * An operator running their own show sees one entry and nothing else changes.
 * The moment they are looking at somebody else's, the whole page gets a border
 * and the strip says whose - because the failure this prevents is putting a
 * graphic on the wrong stream, and that is not a mistake a dropdown alone
 * stops somebody making.
 */
function paintTopbar() {
  if (!me) return;

  const current = SESSION_ID || me.user.id;
  els.target.replaceChildren(
    ...me.sessions.map((entry) =>
      el(
        'option',
        null,
        { value: entry.id, selected: entry.id === current ? 'selected' : null },
        entry.id === me.user.id ? `${entry.username} (yours)` : `${entry.username} - ${entry.level}`,
      ),
    ),
  );

  const guest = current !== me.user.id;
  const mine = me.sessions.find((entry) => entry.id === current);
  els.whoamiUser.textContent = `${me.user.username}${me.user.role === 'admin' ? ' - admin' : ''}`;
  els.whoami.hidden = false;
  // Only worth a selector when there is somewhere to go.
  els.target.parentElement.hidden = me.sessions.length < 2;
  document.body.classList.toggle('is-guest', guest);
  document.body.dataset.guestNote = guest ? `Operating ${mine?.username ?? 'another'}'s production` : '';

  if (els.adminTab) els.adminTab.hidden = me.user.role !== 'admin';
}

els.target.addEventListener('change', () => {
  // Your own session is the plain URL, not ?session=<your id>: a bookmark that
  // names you is one that breaks when it is shared with a colleague.
  switchTo(els.target.value === me.user.id ? '' : els.target.value);
});

// --------------------------------------------------------------- account ---

function paintAccount() {
  if (!me) return;

  facts(els.facts, [
    ['Username', me.user.username],
    ['Role', me.user.role === 'admin' ? 'Administrator' : 'Operator'],
    ['Account made', when(me.user.createdAt)],
    ['Last signed in', when(me.user.lastLoginAt)],
  ]);

  els.key.textContent = me.user.sessionKey ?? '-';
  els.note.textContent = `Passwords must be at least ${me.passwordMin} characters.`;
  paintGrants();
}

/**
 * The access list.
 *
 * One row per other account, each a three-way choice rather than an add/remove
 * pair - "no access, viewer, editor" is the whole of what can be true, and a
 * list of everyone makes revoking as easy to find as granting. With one account
 * on the server there is nobody to show, and saying so is better than an empty
 * box.
 */
function paintGrants() {
  if (!me.grantable.length) {
    els.grants.replaceChildren(
      el('p', 'field-help', {}, 'There are no other accounts yet. An administrator can make one on the Admin tab.'),
    );
    return;
  }

  els.grants.replaceChildren(
    ...me.grantable.map((other) => {
      const row = el('div', 'access-row');
      row.append(el('span', 'access-name', {}, other.username));

      for (const [level, label] of [['', 'No access'], ['viewer', 'Viewer'], ['editor', 'Editor']]) {
        const button = el('button', `btn btn-small${other.level === level ? ' is-active' : ''}`, { type: 'button' }, label);
        button.addEventListener('click', async () => {
          try {
            const payload = await post('/api/account/grant', { userId: other.id, level });
            me.grantable = payload.grantable;
            me.user = payload.user;
            paintGrants();
            toast(level ? `${other.username} can now ${level === 'editor' ? 'operate' : 'watch'} your graphics` : `${other.username} no longer has access`);
          } catch (error) {
            toast(error.message);
          }
        });
        row.append(button);
      }
      return row;
    }),
  );
}

els.savePassword.addEventListener('click', async () => {
  if (els.fresh.value !== els.again.value) {
    els.note.textContent = 'The two new passwords do not match.';
    return;
  }

  els.savePassword.disabled = true;
  try {
    await post('/api/account/password', { current: els.current.value, password: els.fresh.value });
    els.current.value = els.fresh.value = els.again.value = '';
    // The server ends every other login for this account and re-issues this
    // one, so the page carries on working and every other browser does not.
    els.note.textContent = 'Password changed. Any other browser signed in as you has been signed out.';
    toast('Password changed');
  } catch (error) {
    els.note.textContent = error.message;
  } finally {
    els.savePassword.disabled = false;
  }
});

els.copyKey.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.key.textContent);
    toast('Key copied');
  } catch {
    toast('Could not reach the clipboard - select the key and copy it by hand');
  }
});

els.rotate.addEventListener('click', async () => {
  const warning =
    'Make a new key?\n\nEvery OBS browser source and both webhook URLs stop working until you re-copy them. Do not do this mid-show.';
  if (!window.confirm(warning)) return;

  try {
    const payload = await post('/api/account/key', {});
    me.user = payload.user;
    els.key.textContent = me.user.sessionKey;
    await refreshAccount();
    toast('New key made - re-copy the OBS and webhook URLs');
  } catch (error) {
    toast(error.message);
  }
});

// ----------------------------------------------------------------- admin ---

async function loadAdmin() {
  if (me?.user.role !== 'admin') return;

  try {
    const [userData, health, settingData] = await Promise.all([
      fetch('/api/admin/users').then((r) => r.json()),
      fetch('/api/admin/health').then((r) => r.json()),
      fetch('/api/admin/settings').then((r) => r.json()),
    ]);
    paintUsers(userData.users ?? []);
    paintHealth(health);
    paintSettings(settingData);
  } catch (error) {
    els.admNote.textContent = `Could not load: ${error.message}`;
  }
}

/**
 * The server switches, rendered from SETTING_FIELDS.
 *
 * Three states, not two. A switch whose requirement the environment does not
 * provide is shown off and disabled with the reason underneath - because
 * "somebody turned this off" and "this server cannot do it" send an
 * administrator to two completely different places, and a greyed-out checkbox
 * on its own says neither.
 */
function paintSettings({ settings, available }) {
  els.admSettings.replaceChildren(
    ...SETTING_FIELDS.map((entry) => {
      const usable = !entry.requires || available?.[entry.requires] !== false;
      const on = Boolean(settings[entry.key]) && usable;

      const box = el('input', null, { type: 'checkbox', id: `set-${entry.key}` });
      box.checked = on;
      box.disabled = !usable;

      const row = el('div', `setting-row${usable ? '' : ' is-off'}`);
      const label = el('label', 'setting-head', { for: `set-${entry.key}` });
      label.append(box, el('span', 'setting-label', {}, entry.label));
      row.append(label, el('p', 'field-help', {}, entry.help));

      const state = el('p', 'setting-state');
      const say = () => {
        state.textContent = !usable ? entry.missing : box.checked ? 'On.' : entry.off;
        row.classList.toggle('is-off', !usable || !box.checked);
      };
      say();
      row.append(state);

      box.addEventListener('change', async () => {
        box.disabled = true;
        try {
          const payload = await post('/api/admin/settings', { settings: { [entry.key]: box.checked } });
          box.checked = Boolean(payload.settings[entry.key]);
          say();
          toast(`${entry.label} ${box.checked ? 'on' : 'off'}`);
          // The switches change what the lookup tab may offer, and that tab read
          // its config once at boot. Reloading is blunt but it is also the only
          // thing that cannot leave half the page believing the old answer.
          if (window.confirm('Setting saved. Reload the dashboard so every tab picks it up?')) location.reload();
        } catch (error) {
          box.checked = !box.checked;
          say();
          toast(error.message);
        } finally {
          box.disabled = false;
        }
      });

      return row;
    }),
  );
}

function paintHealth(health) {
  const hours = Math.floor(health.uptimeSec / 3600);
  const minutes = Math.floor((health.uptimeSec % 3600) / 60);

  facts(els.admHealth, [
    ['Up for', hours ? `${hours}h ${minutes}m` : `${minutes}m`],
    ['Node', health.node],
    ['Accounts', health.accounts],
    ['Open logins', health.logins],
    ['Live productions', `${health.openSessions}${health.openSessions ? ` (${health.liveSessions.length} loaded)` : ''}`],
    ['Open streams', health.streams],
    ['Memory', `${health.rssMb} MB resident, ${health.heapMb} MB heap`],
    ['Listening on', `${health.host}:${health.port}`],
    ['Cookie', health.cookieSecure ? 'HTTPS only' : 'sent over plain HTTP too'],
    ['HenrikDev key', health.providers.henrik ? 'loaded' : 'missing'],
    ['Riot key', health.providers.riot ? 'loaded' : 'missing'],
    [
      'tracker.gg',
      !health.tracker.available
        ? 'not available on this server'
        : !health.tracker.enabled
          ? 'switched off'
          : health.tracker.loginActive
            ? `login running (${health.tracker.loginPhase}) - ${health.tracker.startedBy || 'unknown'}`
            : health.tracker.browserOpen
              ? 'ready, browser open'
              : 'ready, browser not started',
    ],
    ['Post-match watch', health.watch ? 'enabled' : 'switched off'],
  ]);
}

function paintUsers(list) {
  els.admUsers.replaceChildren(
    ...list.map((user) => {
      const row = el('div', `admin-row${user.disabled ? ' is-off' : ''}`);
      row.append(
        el('span', 'admin-name', {}, user.username),
        el('span', 'admin-meta', {}, user.role === 'admin' ? 'Administrator' : 'Operator'),
        el('span', 'admin-meta', {}, user.live ? 'production loaded' : `last in ${when(user.lastLoginAt)}`),
      );

      const act = async (label, body, confirmText) => {
        if (confirmText && !window.confirm(confirmText)) return;
        try {
          await post('/api/admin/users', { id: user.id, ...body });
          await loadAdmin();
          toast(label);
        } catch (error) {
          toast(error.message);
        }
      };

      const disable = el('button', 'btn btn-small', { type: 'button' }, user.disabled ? 'Enable' : 'Disable');
      disable.addEventListener('click', () =>
        act(
          user.disabled ? `${user.username} enabled` : `${user.username} disabled`,
          { action: 'update', disabled: !user.disabled },
          user.disabled ? null : `Disable ${user.username}? They are signed out immediately and their OBS key stops working.`,
        ),
      );

      const promote = el('button', 'btn btn-small', { type: 'button' }, user.role === 'admin' ? 'Make operator' : 'Make admin');
      promote.addEventListener('click', () =>
        act(`${user.username} is now ${user.role === 'admin' ? 'an operator' : 'an administrator'}`, {
          action: 'update',
          role: user.role === 'admin' ? 'user' : 'admin',
        }),
      );

      /*
       * The tracker.gg solve permission.
       *
       * Its own control rather than something implied by the role, because what
       * it opens is an interactive keyboard on a real browser on the production
       * machine - a bigger thing than an account is otherwise worth. Off by
       * default; admins have it regardless, so the button says so instead of
       * offering a toggle that would do nothing.
       */
      const tracker = el(
        'button',
        `btn btn-small${user.mayOpenTrackerLogin ? ' is-active' : ''}`,
        { type: 'button', title: 'Whether this account may open a tracker.gg Cloudflare login on the server' },
        user.role === 'admin' ? 'Tracker login (admin)' : user.trackerLogin ? 'Tracker login on' : 'Tracker login off',
      );
      tracker.disabled = user.role === 'admin';
      tracker.addEventListener('click', () =>
        act(
          `${user.username} ${user.trackerLogin ? 'can no longer' : 'can now'} open a tracker login`,
          { action: 'update', trackerLogin: !user.trackerLogin },
          user.trackerLogin
            ? null
            : `Let ${user.username} open a tracker.gg login?\n\nThat gives them an interactive browser session on this server while a solve is running.`,
        ),
      );

      const signOut = el('button', 'btn btn-small', { type: 'button' }, 'Sign out');
      signOut.addEventListener('click', () => act(`${user.username} signed out everywhere`, { action: 'sign-out' }));

      const remove = el('button', 'btn btn-small btn-danger', { type: 'button' }, 'Delete');
      remove.addEventListener('click', () =>
        act(
          `${user.username} deleted`,
          { action: 'delete' },
          `Delete ${user.username}?\n\nTheir graphics, presets, teams and player aliases are deleted with them. This cannot be undone.`,
        ),
      );

      row.append(disable, promote, tracker, signOut, remove);
      return row;
    }),
  );
}

els.admCreate.addEventListener('click', async () => {
  els.admCreate.disabled = true;
  try {
    await post('/api/admin/users', {
      action: 'create',
      username: els.admUsername.value,
      password: els.admPassword.value,
      role: els.admIsAdmin.checked ? 'admin' : 'user',
    });
    els.admUsername.value = els.admPassword.value = '';
    els.admIsAdmin.checked = false;
    els.admNote.textContent = '';
    await loadAdmin();
    // Their name has to appear in your own access list without a reload, or
    // the obvious next move - sharing a production with the person you just
    // made an account for - does not work.
    me = (await refreshAccount()) ?? me;
    paintGrants();
    toast('Account created');
  } catch (error) {
    els.admNote.textContent = error.message;
  } finally {
    els.admCreate.disabled = false;
  }
});

els.admRefresh.addEventListener('click', () => void loadAdmin());

// ------------------------------------------------------------------- log ---

/**
 * The log panel.
 *
 * Polled rather than streamed, deliberately. A browser allows six connections
 * to an origin and this dashboard has already deadlocked itself once by
 * spending them; a fourth event stream for a panel somebody looks at twice a
 * month is not the place to spend the fifth. Three seconds is fast enough to
 * watch something go wrong in real time.
 *
 * `cursor` is a sequence number, so each poll asks only for what it has not
 * seen - two lines can share a millisecond, and a clock can go backwards.
 */
let logCursor = 0;
let logLines = [];
let logTimer = null;

const LOG_MAX = 500;

const logLine = (entry) => {
  const at = new Date(entry.at).toISOString().slice(11, 19);
  const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
  return `${at} ${entry.level.toUpperCase().padEnd(5)} ${entry.tag.padEnd(9)} ${entry.message}${meta}`;
};

function paintLog() {
  const wanted = els.logFilter.value.trim().toLowerCase();
  const shown = wanted ? logLines.filter((line) => line.toLowerCase().includes(wanted)) : logLines;

  els.logView.textContent = shown.join('\n');
  els.logCount.textContent = `${shown.length}${wanted ? ` of ${logLines.length}` : ''} lines`;

  // Only when it is already at the bottom, or reading anything above it becomes
  // impossible the moment a line arrives.
  if (els.logFollow.checked) els.logView.scrollTop = els.logView.scrollHeight;
}

async function pollLog() {
  if (me?.user.role !== 'admin') return;

  try {
    const payload = await fetch(`/api/admin/logs?since=${logCursor}&limit=500`).then((r) => r.json());
    logCursor = payload.cursor ?? logCursor;

    if (payload.entries?.length) {
      // The server hands them back newest first, which is right for a listing
      // and wrong for a log - a log reads downwards.
      logLines.push(...payload.entries.slice().reverse().map(logLine));
      if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
      paintLog();
    }

    if (payload.levels && !els.logLevel.options.length) {
      els.logLevel.replaceChildren(
        ...payload.levels.map((name) =>
          el('option', null, { value: name, selected: name === payload.level ? 'selected' : null }, name),
        ),
      );
      els.logLevel.value = payload.level;
    }
  } catch {
    // A poll that fails is not worth a toast every three seconds.
  }
}

els.logLevel.addEventListener('change', async () => {
  try {
    await post('/api/admin/logs', { level: els.logLevel.value });
    toast(`Logging at ${els.logLevel.value}`);
  } catch (error) {
    toast(error.message);
  }
});

els.logFilter.addEventListener('input', paintLog);

els.logCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.logView.textContent);
    toast('Log copied');
  } catch {
    toast('Could not reach the clipboard - select the text and copy it by hand');
  }
});

// Loaded when the tab is opened rather than at boot: health is a snapshot and a
// stale one is worse than none, and the whole panel is irrelevant to the
// operator who never opens it.
window.addEventListener('app-tab', (event) => {
  const here = event.detail === 'admin';
  if (here) void loadAdmin();

  // Polled only while the tab is open. A request every three seconds for a
  // panel nobody is looking at is a request every three seconds for nothing,
  // and this dashboard's connection budget is six.
  clearInterval(logTimer);
  logTimer = null;
  if (!here) return;

  void pollLog();
  logTimer = setInterval(() => void pollLog(), 3000);
});

// ------------------------------------------------------------------ boot ---

// Signing out is a POST, so it cannot be a plain link - and it must clear the
// server's record of the token, not only the cookie.
document.addEventListener('click', async (event) => {
  if (!event.target.closest('#whoami-user')) return;
  if (!window.confirm('Sign out?')) return;
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.assign('/login.html');
});

void account().then((data) => {
  if (!data) return; // not signed in; the server has already redirected
  me = data;
  paintTopbar();
  paintAccount();
});
