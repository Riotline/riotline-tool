# Deploying Riotline Tool

Running the broadcast graphics server on a remote machine, in Docker.

This is the deployment guide. It does not describe what the tool does or how to
operate it — the dashboard explains itself, and that is where feature
documentation lives.

---

## What you are deploying

One container. Inside it:

- the Node server (no framework, no database, no build step)
- a Chromium, used only by the optional tracker.gg data source
- Xvfb, x11vnc and noVNC, used only when somebody clears a Cloudflare challenge

Outside it: one Docker volume holding everything that must survive a redeploy,
and a reverse proxy or tunnel in front of the published port.

Each account gets its own set of graphics. Two operators can run two matches at
the same time on one server without touching each other's work.

---

## Before you start

You need:

| | |
| --- | --- |
| A host | 2 GB RAM is comfortable; 1 GB works if you leave tracker.gg off. ~2.5 GB disk for the image. |
| Docker | Engine 20.10+, with the Compose plugin. |
| A hostname with HTTPS | A Cloudflare tunnel or any reverse proxy that terminates TLS. See [Exposing it](#exposing-it). |
| A HenrikDev API key | Free, from their Discord: <https://discord.gg/henrikdev>. This is the primary data source. |

You do **not** need a Riot production API key. The tool works without one.

---

## Install

```bash
git clone https://github.com/Riotline/riotline-tool.git
cd riotline-tool
cp .env.example .env
```

Open `.env` and set, at minimum:

```ini
ADMIN_USERNAME=yourname
ADMIN_PASSWORD=at-least-twelve-characters
HENRIK_API_KEY=your-key
```

Then:

```bash
docker compose up -d --build
```

The first build takes several minutes — it downloads a Chromium. Later builds
reuse it unless `package.json` changes.

Check it came up:

```bash
docker compose logs
curl -s localhost:8080/api/health
```

The log ends with a banner naming the port, the account it created, and whether
each data source is available. Then open the hostname in a browser and sign in.

### The first administrator

There is deliberately **no "create the first account" page**. A route that hands
out an admin account to whoever reaches it first is a race a stranger can win,
and this server is meant to be reachable from the internet. So the first account
comes from `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the environment — because
whoever can set an environment variable already owns the machine.

It is created on boot only if that username does not already exist, and it is
**never re-applied**. Change the password on the Account tab, not in `.env`;
otherwise a stale `.env` would silently undo the change on every restart.

Everyone else is created from **Admin → Accounts** by an administrator.

---

## Exposing it

The compose file publishes on **loopback only**:

```yaml
ports:
  - "127.0.0.1:8080:8080"
```

That is deliberate. The server speaks plain HTTP, and the login cookie is only as
private as the transport under it. Put something in front that terminates TLS.

**Pick one of the two below — they do the same job.** A Cloudflare tunnel if the
host has no public IP or you would rather not open a port; nginx if it already
has one and you want no third party in the path. Running both only makes sense
when nginx is already on that host serving other things and you want it doing the
routing, and it buys nothing here on its own.

Two things must be true of whatever you put in front:

1. **It must forward WebSocket upgrades.** The Cloudflare-solve viewer is a
   websocket under `/tracker-login/`. Without upgrade support the panel loads
   and then sits there connecting for ever.
2. **It must not buffer server-sent events.** Every graphic updates over SSE. A
   proxy that buffers will make the dashboard and every OBS source freeze —
   `nginx` needs `proxy_buffering off;` (the server already sends
   `X-Accel-Buffering: no`, which nginx honours).

### Option A — Cloudflare Tunnel

The tunnel handles TLS, forwards websockets, and needs no open inbound port. It
works from behind NAT, so the host needs no public IP at all.

```bash
cloudflared tunnel create riotline
cloudflared tunnel route dns riotline gfx.example.com
```

```yaml
# ~/.cloudflared/config.yml
tunnel: riotline
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: gfx.example.com
    service: http://localhost:8080
    originRequest:
      # SSE holds a connection open for the whole broadcast.
      noTLSVerify: false
      connectTimeout: 30s
  - service: http_status:404
```

A tunnel maps **one** hostname to **one** port. That is why the noVNC viewer is
proxied through the app's own origin rather than published on 6080 — a second
port could not be reached through the tunnel at all.

### Option B — nginx

Needs a public IP, ports 80 and 443 open, a DNS A record, and a certificate of
your own (certbot). No third party in the path.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;

    # Server-sent events. Without these the graphics stop updating.
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

### Once you are on HTTPS

Set this in `.env` and restart:

```ini
COOKIE_SECURE=true
```

The login cookie then refuses to travel over plain HTTP.

> **Do not set it while testing on `http://127.0.0.1`.** A `Secure` cookie is
> silently dropped over plain HTTP: the login will appear to succeed and then
> bounce you straight back to the sign-in page, with nothing in any log.

---

## Configuration

Everything is environment variables. Real environment variables always beat the
`.env` file, so compose can override anything without editing it.

### Set by the image — do not change

| | | |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Docker's published port forwards to the container's eth0, not its loopback. A server bound to `127.0.0.1` *inside* a container is unreachable no matter what you publish. |
| `STATE_DIR` | `/data/state` | Operator state, on the volume. |
| `PROFILE_DIR` | `/data/profile` | The Chromium profile, on the volume. A **subdirectory** of the mount, never the mount itself — see [Why the profile is not the mount point](#why-the-profile-is-not-the-mount-point). |

### Worth setting

| | |
| --- | --- |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | The first administrator. Password minimum 12 characters. |
| `HENRIK_API_KEY` | The primary data source. |
| `COOKIE_SECURE` | `true` once you are behind HTTPS. |
| `HENRIK_AFFINITY` | `ap` `br` `eu` `kr` `latam` `na` — your region. |
| `DEFAULT_PROVIDER` | Which source the lookup tab starts on. Leave it `henrik`. |
| `TRACKER_ENABLED` | `true` to allow the tracker.gg fallback. See below. |
| `RIOT_API_KEY` | Optional. Riot's own endpoints need a production key. |
| `LOG_LEVEL` | `error` `warn` `info` `debug`. See [Logs](#logs). |

The rest are in `.env.example` with a comment each.

### Signing in with Discord

Optional, and off unless all six are set. A guild role becomes the roster: hold
the role, get an account. Password sign-in stays available beside it, and must —
see the warning at the end.

| | |
| --- | --- |
| `DISCORD_ENABLED` | `true` to offer it. Separate from the five below so you can shut the door without deleting the setup. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From the OAuth2 tab of your app at <https://discord.com/developers/applications>. The **client secret**, not a bot token. |
| `DISCORD_GUILD_ID` | Your Discord server. |
| `DISCORD_ROLE_OPERATOR` | The role that grants an account. Several, comma-separated, is fine. |
| `DISCORD_PUBLIC_ORIGIN` | The public URL this server answers to — scheme and host only. |

In the Discord application, add a redirect URI of exactly
`<DISCORD_PUBLIC_ORIGIN>/api/auth/discord/callback`. Discord compares it byte for
byte, so a trailing slash or `http` where you meant `https` fails at the consent
screen with an error naming the URI.

**`DISCORD_PUBLIC_ORIGIN` cannot be worked out by the server.** Behind the
tunnel it never learns its own hostname: `HOST` is `0.0.0.0` in the container,
the published port is on the host's loopback, and the `Host` header is set by
whoever is calling — trusting that would hand an attacker the redirect target.
So it is declared. Behind the tunnel it is the tunnel hostname, `https`, and
`COOKIE_SECURE=true` belongs with it.

Everything is validated at boot. A malformed guild or role id, or an origin with
a path on it, leaves Discord off, names the offending variable in the banner and
hides the button — rather than accepting it and then telling every member of
your org that they lack a role they hold.

Optional: `DISCORD_ROLE_ADMIN` (a second role that also administers here),
`DISCORD_ROLE_NAME` (what to call the role in the refusal message) and
`DISCORD_ALLOW_SIGNUP=false` (existing accounts may link, but no new account is
ever created).

**The role is checked when somebody signs in, and not again.** Removing it in
Discord stops the next sign-in; it does not end a session already running. To
remove somebody now, use **Disable** in Admin → Accounts, which signs them out
immediately. **Delete does not evict anyone** — it deletes their graphics, and
a role holder can sign straight back in with a fresh empty account. The panel
says so on the confirmation.

Discord also has a switch in **Admin -> Server settings**, so an administrator can
shut the door without a restart - the credentials stay in place and it comes
straight back on. It stops new sign-ins and new links; it does not end sessions
already running, which is what Disable on an account is for.

**Keep at least one administrator with a password.** If every admin signs in
through Discord, a rotated client secret or a deleted application locks this
server out of itself. The server refuses any change that would take the last
password-holding administrator away, warns on the boot banner, and reports
`passwordAdmins` in Admin → Health.

### The two runtime switches

Some settings are not environment variables at all — they live in **Admin →
Server settings** and change without a restart:

- **tracker.gg as a data source** — closes the Chromium when switched off.
- **Post-match lookup across several accounts** — the ten-account watch.

`TRACKER_ENABLED` and the tracker switch answer different questions, and both
must be true. The environment variable says whether this machine *can* (is there
a Chromium?); the switch says whether it *should* right now. If `TRACKER_ENABLED`
is unset, the admin panel shows the switch as unavailable rather than merely off,
and says which.

---

## Logs

Two places at once: the container's stdout, where `docker compose logs` finds
them, and a buffer in the server's memory that the **Admin → Log** panel reads.

The panel exists because the person who needs the log during a broadcast is
standing at a desk with OBS open and cannot get to a shell. It holds the last
500 lines (`LOG_BUFFER`), filters as you type, and follows new lines as they
arrive. Anything older is in `docker compose logs`.

### Levels

| | |
| --- | --- |
| `error` | something failed |
| `warn` | a refusal — a bad sign-in, a request denied, a rotated key still in use |
| `info` | **the default.** Who signed in, what went on air, what the game feed said, every admin action |
| `debug` | **verbose.** Every request with its status and duration, every event stream, every roster event |

`info` is what a show should produce — enough to reconstruct it afterwards
without drowning in reads.

**Change it from the Admin tab, not the environment.** It takes effect
immediately, and that is the whole point: the moment you want verbose output is
the moment a restart would take every graphic off air. `LOG_LEVEL` only sets
where it starts.

### What is never logged

Session keys, passwords, password hashes, cookies and the noVNC password. A
`?key=` in a URL is written as `key=<hidden>`, and redaction happens **on the
way into** the buffer rather than on the way out — the buffer is rendered in a
browser, so anything that reached it has already left the server.

The health check is dropped entirely. Docker runs it every thirty seconds
forever, and a log whose bulk is "the server is still up" is one nobody reads
the rest of.

### What to look for after a bad show

- `air` — what went on and off, with timestamps. `scoreboard on` / `winner
  sequence scene 2` / `agent select clock started`.
- `feed` — what the game client sent. At `info` you get scene changes; at
  `debug`, every roster event.
- `request` with a 4xx or 5xx — anything refused or broken, and who asked.
- `tracker` — how far a Cloudflare solve got. `starting` with no `ready` means
  the viewer stack never came up; `ready` with no `passed` means nobody cleared
  the challenge in time.

---

## Data and backups

One volume, `riotline-data`, with two directories:

```
/data/state/     accounts, graphics, presets, teams, aliases, uploaded media
/data/profile/   the Chromium profile holding the tracker.gg clearance
```

**`/data/state` is irreplaceable.** The media store is content-addressed and has
no delete route, so every logo, background and audio track anybody has ever
uploaded is in there, along with the accounts and their password hashes.

`/data/profile` is merely expensive to lose: you would have to solve the
Cloudflare challenge again.

### Back it up

```bash
docker run --rm -v riotline-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/riotline-$(date +%F).tar.gz -C /data .
```

### Restore

```bash
docker compose down
docker run --rm -v riotline-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/riotline-2026-01-01.tar.gz -C /data'
docker compose up -d
```

Back up before every upgrade. It takes seconds.

---

## Upgrading

```bash
git pull
docker compose up -d --build
```

The volume outlives the image, so state carries over. Read the log afterwards —
the banner reports how many accounts were restored.

---

## The tracker.gg source

Optional, and off by default. HenrikDev is the primary source; tracker.gg is the
fallback for custom games HenrikDev has not indexed.

It needs a real browser, because the site is Cloudflare-protected and loads its
match list by XHR after render. That is the only reason this image is 1.5 GB
rather than 100 MB. If you do not need it, leave `TRACKER_ENABLED=false`.

### Clearing the challenge

Cloudflare issues a clearance bound to the **IP address and user agent that
earned it**. Solving the challenge in your own browser would earn a clearance
for your laptop and do nothing for the server. So the solve has to happen in the
server's own Chrome — which is what the viewer is for.

1. **Global → tracker.gg access → Open the login.**
2. A browser window from the server appears in the page. Click through the
   challenge as you would anywhere.
3. Press **Done**. The window has no title bar to close.
4. Run a lookup with the tracker source to confirm it took.

The clearance lands in `/data/profile` and every later headless lookup reuses it.
Re-run this when it expires.

Notes:

- Only one solve can run at a time, server-wide. There is one browser.
- **Who may start one is a per-account permission**, off by default. Grant it
  under **Admin → Accounts → Tracker login**. Administrators always have it.
- **Only the operator who started it, and administrators, are shown the viewer
  password.** What is on the other end is a real keyboard on a real browser on
  your server, not a picture of one — treat the permission accordingly.
- A solve takes the lookup browser away from everyone for its duration. The
  dashboard says who is holding it, and only they (or an admin) can end it.
- The panel is hidden entirely from accounts that do not have the permission,
  and from everyone when the source is switched off.

### Why it is a permission rather than a role

The clearance a solve wins is shared — one browser, one profile, one server — so
restricting it to administrators would mean waiting for one when a data source
is down mid-event. But it cannot be implied by simply having an account either:
"viewer" is a property of a *grant on one production*, never of a person, and
everyone owns their own production. Somebody given a look at one dashboard could
otherwise switch back to their own and open a desktop on your server.

So it is its own flag, granted deliberately, and off until somebody grants it.

---

## Operating notes

### Getting graphics into OBS

Each account has its own **session key**, shown on the Account tab and already
embedded in the URLs on each graphics tab. Copy them from there.

```
https://gfx.example.com/output.html?key=<session key>
https://gfx.example.com/winner.html?key=<session key>
https://gfx.example.com/select.html?key=<session key>
```

Browser source, **1920×1080**, no custom CSS. The scoreboard and agent select are
transparent; the winner sequence is full screen.

The two game webhooks carry the same key:

```
POST https://gfx.example.com/api/roster?key=<session key>
POST https://gfx.example.com/api/game?key=<session key>
```

**Treat the session key as a password that lives in a URL.** Anyone holding it
can watch your graphics and feed your agent select. It opens those pages and
those two webhooks and nothing else — never the dashboard, never your account.
If one ends up on stream, press **Make a new key** on the Account tab and re-copy
the URLs. Every old URL stops working at once, so do not do it mid-show.

### Sharing a production

**Account → Who can operate your graphics.** An *editor* can do everything you
can, including putting things on air. A *viewer* can watch and change nothing.

When somebody is operating a production that is not their own, their whole page
gets a border and a bar naming whose desk it is. That is deliberate: an editor's
dashboard is otherwise identical to their own, and the mistake waiting there is
putting a graphic on the wrong stream.

Administrators are **not** given automatic access to everybody's graphics.
Administering accounts and taking over a live broadcast are different powers; an
admin who needs to operate a production is granted access like anyone else.

---

## Troubleshooting

### `docker compose up` succeeds but nothing answers

Check the bind:

```bash
docker compose logs | grep "Listening on"
```

It must say `0.0.0.0:8080`. If it says `127.0.0.1`, something is overriding
`HOST` — usually a stale `HOST=127.0.0.1` line in `.env`.

### The login accepts the password and bounces straight back

`COOKIE_SECURE=true` while reaching the server over plain HTTP. The browser is
dropping the cookie without telling anyone. Set it to `false`, or put HTTPS in
front.

### The dashboard says "Saving…" for ever, or graphics stop updating

A proxy buffering server-sent events. See [Exposing it](#exposing-it). Confirm
with:

```bash
curl -N https://gfx.example.com/api/health
```

then check your proxy's buffering settings.

### The tracker login panel says "failed" immediately

```bash
docker compose exec riotline sh -c 'ls -l docker/tracker-login-session.sh'
```

It must be executable and its first line must end without a `\r`. A script
committed from a Windows checkout without `.gitattributes` gets CRLF endings, and
a shebang ending in `\r` fails to execute with `ENOENT` — which surfaces only as
this message. The repository carries `.gitattributes` to prevent it; a build from
a zip may not.

### Chromium crashes, or screenshots come out blank

Shared memory. `shm_size: 1gb` is in the compose file — if you are running
`docker run` by hand, pass `--shm-size 1g`.

### The first solve after a hard restart fails

An X lock left behind by a container that was killed rather than stopped. The
script clears a stale one automatically, and `stop_grace_period: 30s` gives its
cleanup time to run — use `docker compose stop`, not `docker kill`.

### Somebody's OBS shows nothing

The key is missing or has been rotated. `?key=` is required on the output pages —
a browser source has no login. Re-copy the URL from the dashboard.

### Health check

```bash
docker inspect --format '{{.State.Health.Status}}' riotline-tool
```

`/api/health` is deliberately outside the login: a health check has no cookie and
never will. It reports only that the process is up and how long for.

---

## Notes for whoever maintains this

### Why bookworm and not the default Node tag

Playwright's dependency table has entries for `debian12` and several Ubuntu
releases, and **nothing for `debian13`/trixie** — which is what the default
`node:22` tag now is. On trixie, `playwright install --with-deps` prints a
warning, installs nothing, and Chromium then fails with a missing-library error
that points nowhere near the real cause. Bookworm also still uses the
pre-`time_t64` package names in the Dockerfile; do not transplant that list onto
trixie or noble without renaming them.

The Dockerfile installs the libraries explicitly rather than with `--with-deps`,
so a missing one is a build failure rather than a warning.

### Why the profile is not the mount point

`PROFILE_DIR` is `/data/profile`, a subdirectory *inside* the volume.

`browser.js` recovers from a poisoned Cloudflare clearance by deleting and
recreating that directory. Removing a directory that is a mount point returns
`EBUSY`, and `force: true` suppresses only `ENOENT`. Mount the volume at the
profile directly and the recovery fails **silently** — the one automatic repair
for a clearance that has gone bad never fires, and `npm run tracker:reset` always
reports that it could not clear the profile.

### Why the viewer is proxied rather than published

websockify listens on loopback inside the container, and the app proxies
`/tracker-login/` through its own origin. A published second port is exactly what
a Cloudflare tunnel cannot carry — it maps one hostname to one port. Proxying
means the viewer works over the tunnel, on the LAN, and on localhost without the
client needing to know where it really lives.

### The three secrets

They are deliberately separate, and weakest last:

| | Where it lives | What it opens |
| --- | --- | --- |
| password | scrypt hash on disk | making a login |
| login token | httpOnly cookie | the dashboard, as that person |
| session key | `?key=` in OBS and webhook URLs | that session's output pages and its two webhooks |

The session key is weak by design — it is typed into OBS configuration and read
aloud over screen shares. `KEYED_ROUTES` in `server.js` is the complete list of
what it reaches, and it is a list rather than a rule so that adding a route
forces somebody to decide.
