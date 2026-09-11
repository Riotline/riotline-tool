# Companion control channel

WebSocket reference. Generated from `public/companion-schema.js` — if it is listed here, the server accepts or sends it.

```
ws://<host>:8080/api/companion?key=<control key>
```

Key comes from the dashboard: **Account → Stream deck / Bitfocus Companion → Create a control key**. It is not the OBS session key. Blank until you make one.

---

## Sending

Plain text, one op per message:

```
winner.next
```

Or JSON, when you need an argument or a correlation id:

```json
{"op": "winner.stage", "value": 2}
{"op": "next", "graphic": "winner", "id": "btn7"}
```

Accepted: `op` / `action` / `command` / `cmd`; `value` / `arg` / `stage` / `scene`; `graphic` / `target`.
Separators `.` `/` `:` all work. Case, spaces, `_` and `-` are ignored in the op name. A trailing CRLF is fine (Companion appends one by default).

## Actions

### `scoreboard` — Scoreboard

| Send | Does |
| --- | --- |
| `scoreboard.show` | Put it on air and play the entry. |
| `scoreboard.hide` | Take it off, playing the exit. |
| `scoreboard.toggle` | Whichever of the two would change something. |
| `scoreboard.replay` | Play the entry again from the start, on air or not. |
| `scoreboard.swap` | Move everything to the other side - names, logos, rosters and scores. Colours stay put; they belong to the design, not the teams. |
| `scoreboard.swapNames` | Move only the names, logos and library links. Rosters and scores stay where the import put them - which is the usual fix after a map where the orgs changed ends. |
| `scoreboard.sort` | Re-order both rosters, so the top player becomes the MVP. |
| `scoreboard.reset` | Clear every field back to defaults. There is no confirmation on a button press. |

Aliases: `on`→`show`, `off`→`hide`, `start`→`show`, `stop`→`hide`, `sides`→`swap`, `swapsides`→`swap`, `names`→`swapNames`, `sortacs`→`sort`

### `winner` — Winner graphic

| Send | Does |
| --- | --- |
| `winner.activate` | Bring the overlay on at scene 1, starting the music if a track is loaded. |
| `winner.stop` | Take the sequence off. The music goes too unless "keep playing" is set. |
| `winner.toggle` | Activate if off, stop if on. |
| `winner.next` | Advance one scene. Refused when off air or already on the last scene - watch winner_can_next. |
| `winner.prev` | Back one scene. Refused when off air or already on the first - watch winner_can_prev. |
| `winner.replay` | Play the sequence again from the top. |
| `winner.stage` *(+ scene number, 1 to 3)* | Jump straight to a scene, bringing the overlay on if it is off. This is the one that works cold - send {"op":"winner.stage","value":2}. |
| `winner.music` | Start or fade the bed without touching the graphic. |
| `winner.musicOn` | Start the bed early, before the sequence. |
| `winner.musicOff` | Fade the bed out, leaving the graphic where it is. |
| `winner.reset` | Clear every field back to defaults. There is no confirmation on a button press. |

Aliases: `show`→`activate`, `on`→`activate`, `start`→`activate`, `hide`→`stop`, `off`→`stop`, `forward`→`next`, `advance`→`next`, `back`→`prev`, `previous`→`prev`, `scene`→`stage`, `musictoggle`→`music`

### `select` — Agent select

| Send | Does |
| --- | --- |
| `select.show` | Put the strip on air. |
| `select.hide` | Take it off. |
| `select.toggle` | Whichever would change something. |
| `select.swap` | Put the other five players on the left. Moves the rosters, not the typed names. |
| `select.clear` | Empty all ten cards and forget the game id. No confirmation on a button press. |
| `select.clockStart` | Start - or restart - the 85 second clock from now. |
| `select.clockEnd` | Fill the bar and stop. Refused if the clock is not running. |
| `select.reset` | Clear every field back to defaults. **⚠ fires immediately** |

Aliases: `on`→`show`, `off`→`hide`, `start`→`show`, `sides`→`swap`, `swapsides`→`swap`, `clearroster`→`clear`, `startclock`→`clockStart`, `endclock`→`clockEnd`, `stopclock`→`clockEnd`

### Requests that are not actions

| Send | Returns |
| --- | --- |
| `ping` | `{"type":"pong"}` |
| `ops` or `help` | `{"type":"ops","graphics":{...}}` — every action name |
| `state` / `status` / `sync` | A full snapshot of all three graphics |
| `{"op":"state","graphic":"winner"}` | A snapshot of one graphic |

---

## What the server sends

| `type` | When | Carries |
| --- | --- | --- |
| `hello` | On connect, first | `protocol`, `session`, `graphics`, `winnerScenes` |
| `state` | On connect, after any change, after any action | `graphic`, `reason`, and that graphic’s variables |
| `ok` | An action succeeded | `graphic`, `op`, `id` if you sent one |
| `error` | An action was refused | `op`, `message`, `id` if you sent one |
| `pong` | Answer to `ping` | — |

`reason` on a `state` is one of `connected`, `requested`, `update`, `clock`, or `op:<name>`.

Rules:

- A full snapshot of all three arrives unprompted on connect. Nothing needs to ask.
- After an action, only the graphic that was touched is sent.
- A change is sent only when a variable below actually changes. Editing anything else is silent.
- An `error` never closes the connection.

---

## Variables

Companion creates none of these automatically. Per value: add the feedback **“Update variable with value from WebSocket message”**, put the name in **both** the JSON Path and the Variable box, read it as `$(<connection>:<name>)`.

- Separator is a **dot**. The module’s own help page says slashes — it is wrong.
- A path that matches nothing **fails silently** and leaves the old value on the button.
- Every `lamp` also arrives as `<name>_n` = `1`/`0`. Use `_n` for button colour via **Variable: Check value**.
- A variable only exists while some button subscribes to it — put all the feedbacks on one spare button.

### `scoreboard`

| Variable | Type | Is |
| --- | --- | --- |
| `scoreboard_visible` | bool +`_n` | On air |
| `scoreboard_air` | text | "ON AIR" or "OFF", for a legend |
| `scoreboard_cue` | number | Cue counter - changes on every transport press |
| `scoreboard_map` | text | Map name |
| `scoreboard_left` | text | Left team name |
| `scoreboard_right` | text | Right team name |
| `scoreboard_left_score` | number | Left rounds won |
| `scoreboard_right_score` | number | Right rounds won |
| `scoreboard_score` | text | Both, as "13-5" |
| `scoreboard_auto_hide_ms` | number | Auto-hide delay, 0 if off |

### `winner`

| Variable | Type | Is |
| --- | --- | --- |
| `winner_active` | bool +`_n` | Sequence is on air |
| `winner_air` | text | "SCENE 2" or "OFF", for a legend |
| `winner_scene` | number | Current scene, 1-based |
| `winner_scene_count` | number | How many scenes there are |
| `winner_scene_key` | text | Scene id - map / winner / score |
| `winner_scene_label` | text | Scene name, for a legend |
| `winner_can_next` | bool +`_n` | Next would do something - use it to grey the button |
| `winner_can_prev` | bool +`_n` | Back would do something |
| `winner_music` | bool +`_n` | Bed is playing |
| `winner_auto_advance` | bool +`_n` | The sequence is running itself |
| `winner_team` | text | Winning team name |
| `winner_team_short` | text | Winning team tricode |
| `winner_left` | text | Left team name |
| `winner_right` | text | Right team name |
| `winner_left_score` | number | Left series score |
| `winner_right_score` | number | Right series score |
| `winner_cue` | number | Cue counter |

### `select`

| Variable | Type | Is |
| --- | --- | --- |
| `select_visible` | bool +`_n` | On air |
| `select_air` | text | "ON AIR" or "OFF" |
| `select_picked` | number | How many have picked |
| `select_locked` | number | How many have locked in |
| `select_total` | number | Seats on the board |
| `select_progress` | text | Picked over total, as "7/10" |
| `select_swap` | bool +`_n` | Sides are swapped |
| `select_clock_running` | bool +`_n` | Clock is counting |
| `select_clock_filled` | bool +`_n` | Clock finished |
| `select_clock_remaining` | number | Seconds left - ticks once a second while running |
| `select_clock` | text | Seconds left as "1:07", blank when stopped |
| `select_scene` | text | What the game client last reported |
| `select_in_agent_select` | bool +`_n` | The client says it is in agent select |
| `select_game_id` | text | Lobby id, when one is known |
| `select_cue` | number | Cue counter |
| `select_slot1_name` | text | Seat 1 - Player name |
| `select_slot1_agent` | text | Seat 1 - Agent, blank until they pick |
| `select_slot1_locked` | bool +`_n` | Seat 1 - Locked in |
| `select_slot2_name` | text | Seat 2 - Player name |
| `select_slot2_agent` | text | Seat 2 - Agent, blank until they pick |
| `select_slot2_locked` | bool +`_n` | Seat 2 - Locked in |
| `select_slot3_name` | text | Seat 3 - Player name |
| `select_slot3_agent` | text | Seat 3 - Agent, blank until they pick |
| `select_slot3_locked` | bool +`_n` | Seat 3 - Locked in |
| `select_slot4_name` | text | Seat 4 - Player name |
| `select_slot4_agent` | text | Seat 4 - Agent, blank until they pick |
| `select_slot4_locked` | bool +`_n` | Seat 4 - Locked in |
| `select_slot5_name` | text | Seat 5 - Player name |
| `select_slot5_agent` | text | Seat 5 - Agent, blank until they pick |
| `select_slot5_locked` | bool +`_n` | Seat 5 - Locked in |
| `select_slot6_name` | text | Seat 6 - Player name |
| `select_slot6_agent` | text | Seat 6 - Agent, blank until they pick |
| `select_slot6_locked` | bool +`_n` | Seat 6 - Locked in |
| `select_slot7_name` | text | Seat 7 - Player name |
| `select_slot7_agent` | text | Seat 7 - Agent, blank until they pick |
| `select_slot7_locked` | bool +`_n` | Seat 7 - Locked in |
| `select_slot8_name` | text | Seat 8 - Player name |
| `select_slot8_agent` | text | Seat 8 - Agent, blank until they pick |
| `select_slot8_locked` | bool +`_n` | Seat 8 - Locked in |
| `select_slot9_name` | text | Seat 9 - Player name |
| `select_slot9_agent` | text | Seat 9 - Agent, blank until they pick |
| `select_slot9_locked` | bool +`_n` | Seat 9 - Locked in |
| `select_slot10_name` | text | Seat 10 - Player name |
| `select_slot10_agent` | text | Seat 10 - Agent, blank until they pick |
| `select_slot10_locked` | bool +`_n` | Seat 10 - Locked in |

---

## Companion setup

1. **Connections** → add **Generic: WebSocket**.
2. **Target URL** → paste the URL from the Account tab.
3. Leave the module’s **ping** off. Reconnect on.
4. Button press → action **Send generic command** → type e.g. `winner.next`.
5. Button feedback → **Update variable with value from WebSocket message** → JSON Path and Variable both set to e.g. `winner_active`.
6. Colour → **Variable: Check value** → `$(ws:winner_active_n)` `=` `1`.

---

## Refusals

| Status | Means |
| --- | --- |
| 401 | No key on the URL |
| 403 | Not a control key — most often the OBS session key was pasted instead |
| 403 | Key was rotated or withdrawn, or the account is disabled |
| 404 | An administrator switched the control channel off |
| 503 | Too many control connections open |

Rotating or removing the key disconnects anything using it immediately.
