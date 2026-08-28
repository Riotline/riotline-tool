#!/bin/bash
#
# One interactive Cloudflare solve, on a throwaway X display, served over noVNC.
#
# server.js spawns this (see trackerLogin.start) when an operator presses "Open
# the login". The clearance tracker.gg issues is bound to the IP and user agent
# that earned it, so the solve has to happen in *this container's* Chrome -
# solving it in the operator's own browser would earn a clearance for their
# laptop and do nothing for the server. So: put a real headed Chromium on a
# virtual display, point a VNC server at that display, wrap it in a websocket,
# and let the operator click the widget from wherever they are.
#
#   Xvfb        the display nobody is looking at directly
#   x11vnc      makes it watchable
#   websockify  makes it watchable from a browser, and serves noVNC's own page
#   node        tools/tracker-login.js, the thing actually being watched
#
# The contract with server.js, which is not obvious from either side alone:
#
#   in    VNC_PASSWORD  8 characters, generated per solve
#         WEB_PORT      the loopback port websockify listens on
#   out   lines of "STATUS <phase> <message...>" on stdout or stderr; anything
#         else is dropped. `ready` is load-bearing - the dashboard reveals the
#         viewer only on that phase. `passed`, `failed` and `closed` are
#         terminal; exiting on any other phase is reported as a failure.
#
# Started in its own process group and cancelled with SIGTERM to the group, so
# the trap below is what actually runs. It has to: without it the X lock stays
# behind and the next solve cannot start.
#
# bash rather than sh on purpose - the readiness checks use /dev/tcp, which
# dash does not have, and the alternative is adding netcat to the image for
# four lines of script.

set -u

WEB_PORT="${WEB_PORT:-6080}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN="${TRACKER_LOGIN_SCREEN:-1600x1000x24}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# noVNC's document root. Debian's package puts it here; a source checkout may
# not, so it is overridable rather than assumed.
NOVNC_DIR="${NOVNC_DIR:-/usr/share/novnc}"

# One line, one phase. Newlines would be parsed as separate frames and a stray
# one would set the phase to something the dashboard has never heard of.
status() { printf 'STATUS %s %s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')"; }

XVFB_PID=""
X11VNC_PID=""
WEBSOCKIFY_PID=""
NODE_PID=""
RFB_AUTH=""
NODE_LOG=""
CLEANED=""

cleanup() {
    # Guarded: this runs from the EXIT trap, and a signal handler that exits
    # would otherwise reach it twice and kill an unrelated pid the second time.
    [ -n "$CLEANED" ] && return
    CLEANED=1

    # Children first, then the lock. Order matters: X will not release the lock
    # while it is still running, and a leftover lock is what stops the *next*
    # solve - a fault nobody would connect back to this one.
    for pid in "$NODE_PID" "$WEBSOCKIFY_PID" "$X11VNC_PID" "$XVFB_PID"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done

    sleep 1

    for pid in "$NODE_PID" "$WEBSOCKIFY_PID" "$X11VNC_PID" "$XVFB_PID"; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    done

    [ -n "$RFB_AUTH" ] && rm -f "$RFB_AUTH"
    [ -n "$NODE_LOG" ] && rm -f "$NODE_LOG"
    rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
}

trap cleanup EXIT
# 143 is what a SIGTERM exit conventionally looks like, and it is what the
# server reads as "the operator pressed Done" rather than as a failure.
trap 'exit 143' INT TERM

fail() {
    status failed "$1"
    exit 1
}

# Nothing here starts instantly, and announcing `ready` before websockify is
# accepting would show the operator a viewer that cannot connect - which reads
# as the feature being broken rather than as being early.
wait_for_port() {
    local port="$1" tries=0
    while [ "$tries" -lt 150 ]; do
        if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
            exec 3>&- 2>/dev/null
            return 0
        fi
        tries=$((tries + 1))
        sleep 0.1
    done
    return 1
}

# --------------------------------------------------------------- checks ---

for binary in Xvfb x11vnc websockify node; do
    command -v "$binary" >/dev/null 2>&1 || fail "$binary is not installed in this image"
done

# vnc.html specifically: the dashboard opens /tracker-login/vnc.html, and some
# noVNC packagings ship only vnc_lite.html.
[ -f "${NOVNC_DIR}/vnc.html" ] || fail "noVNC is missing vnc.html in ${NOVNC_DIR}"
[ -n "$VNC_PASSWORD" ] || fail "no VNC password was supplied"

# A lock left by a solve whose trap never ran - a container killed rather than
# stopped. The lock file holds the X server's pid, so ask whether that process
# is still there rather than guessing. Without this the first solve after every
# hard restart fails, and the reason is invisible.
if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; then
    LOCK_PID="$(tr -dc '0-9' < "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null)"
    if [ -z "$LOCK_PID" ] || ! kill -0 "$LOCK_PID" 2>/dev/null; then
        rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
    else
        fail "display :${DISPLAY_NUM} is already in use"
    fi
fi

mkdir -p /tmp/.X11-unix 2>/dev/null

# ---------------------------------------------------------------- start ---

status starting "Starting the display..."

# Big enough for the 1440x900 viewport browser.js asks for, plus window chrome.
# -nolisten tcp because the only thing that should reach this display is x11vnc,
# which talks to it over the socket in /tmp.
Xvfb ":${DISPLAY_NUM}" -screen 0 "$SCREEN" -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
export DISPLAY=":${DISPLAY_NUM}"

tries=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
    kill -0 "$XVFB_PID" 2>/dev/null || fail "the X display would not start"
    tries=$((tries + 1))
    [ "$tries" -gt 150 ] && fail "the X display did not come up in time"
    sleep 0.1
done

status starting "Starting the viewer..."

# Through a password file, not -passwd on the command line: an argument is
# readable from /proc by anything else in the container, and this password is
# what stands between a stray request and an interactive desktop.
RFB_AUTH="$(mktemp)"
chmod 600 "$RFB_AUTH"
x11vnc -storepasswd "$VNC_PASSWORD" "$RFB_AUTH" >/dev/null 2>&1 || fail "could not set the viewer password"

# -localhost so nothing outside the container reaches VNC directly; the only way
# in is websockify, which the app proxies through its own origin.
# -forever -shared so a second operator opening the viewer does not evict the
# first, and closing a tab does not end the solve for everybody.
x11vnc -display ":${DISPLAY_NUM}" -rfbauth "$RFB_AUTH" -rfbport 5900 -localhost \
    -forever -shared -noxdamage -quiet >/dev/null 2>&1 &
X11VNC_PID=$!
wait_for_port 5900 || fail "the viewer would not start"

# Loopback only, and deliberately so: the app proxies /tracker-login/ through its
# own origin. A published second port is exactly what a Cloudflare tunnel cannot
# carry - it maps one port and nothing else.
websockify --web "$NOVNC_DIR" "127.0.0.1:${WEB_PORT}" "127.0.0.1:5900" >/dev/null 2>&1 &
WEBSOCKIFY_PID=$!
wait_for_port "$WEB_PORT" || fail "the viewer's web server would not start"

# ------------------------------------------------------------ the solve ---

# Only now: the dashboard reveals the iframe on this phase, and it has to be able
# to connect the moment it appears.
status ready "Open the viewer and clear the challenge."

# Headed, on the display above, writing into the same profile the server's own
# lookups read - see PROFILE_DIR in browser.js. The server closes its own browser
# before spawning this, because Chromium allows one per profile.
#
# Its output is kept rather than discarded: when a solve fails, the reason is in
# there, and "the challenge was not cleared" on its own has sent people looking
# in the wrong place.
NODE_LOG="$(mktemp)"
cd "$ROOT" || fail "could not reach the application directory"
node tools/tracker-login.js >"$NODE_LOG" 2>&1 &
NODE_PID=$!

wait "$NODE_PID"
CODE=$?
NODE_PID=""

# tools/tracker-login.js exits 0 only when the challenge was actually cleared.
# 143 is SIGTERM, which is what pressing Done looks like from here - the operator
# ended it deliberately, and calling that a failure told people their solve had
# not worked when it very likely had.
if [ "$CODE" -eq 0 ]; then
    status passed "Challenge cleared - the clearance is saved."
elif [ "$CODE" -eq 143 ] || [ "$CODE" -eq 130 ]; then
    status closed "Browser closed - run a lookup to confirm it took."
else
    DETAIL="$(tail -n 3 "$NODE_LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-160)"
    status failed "exit ${CODE} - ${DETAIL:-no output}"
fi

exit 0
