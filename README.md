# Riotline Tool
Undisclosed tooling developed with AI and heavily scrutinised manually.
To become private upon notice.

Notice: this branch uses alternative sources for the purposes of development and the data required.
Upon proper integration with Riot's endpoints, the unnecessary data sources will be removed.

## Requirements

- **Node.js 18 or newer** (uses the built-in global `fetch`). Node was not
  installed on this machine when the project was created - grab it from
  <https://nodejs.org> if `node --version` fails.

## Setup

1. Copy `.env.example` to `.env`.

2. Start it:

   ```
   node server.js
   ```

   (or `npm start`, which runs the same thing)

3. Open <http://127.0.0.1:8080>.


Match endpoint will not work without a valid production key
Other endpoints work for the purpose of this development.
