# AEM Baltic — Client Task Board

An interactive idea/to-do board for tracking work per client, with pasted
screenshots, hour logging and a billing summary.

Three clients are set up out of the box: **Bazevics**, **Mandrele** and **Others**.

## What it does

- **Floating windows** — each client is a window on a dark halftone desktop. Drag one by its
  title bar to move it, drag the bottom-right corner to resize, click it to bring it to the
  front, and use the − button to roll it up. **Tidy** puts them back in a row. The arrangement
  is remembered per browser and is deliberately *not* synced, so everyone can lay the board
  out how they like without it committing to the repository on every drag.
- **Jobs** — type a job into a client window and press Add. Tick the checkbox when it's
  done, click the text to rename it, drag jobs to reorder them or move them to another client.
- **Hours** — every job has an hours field, and every client has an hourly rate (€/h).
  Each column shows open jobs, done-but-not-invoiced jobs, total hours and the amount owed.
- **Screenshots** — click a client window to make it the paste target, then paste a snip with
  `Ctrl+V`. The image becomes a card in that window. Dragging image files onto a window works
  too. Click a card to enlarge it and give it a caption.
- **Billing report** — the `€ Billing` button lists done jobs per client with hours and
  amounts, copies a plain-text report to the clipboard, and can mark jobs as invoiced so
  they drop out of the "owed" totals while staying in history.

## Setting it up

This repository is **private**, and the board is not published on the web. It runs on each
person's own computer and syncs through GitHub, so client names, jobs and hours are never
served to anyone who is not a collaborator on the repository.

### 1. Get the files onto the computer

```
git clone https://github.com/AEMbaltic/todolist.git
```

Or, without git: **Code → Download ZIP** on GitHub, then unzip it somewhere permanent.

### 2. Start it

- **Windows** — double-click `start.cmd`
- **macOS / Linux** — run `./start.sh`

Either one serves the board at <http://localhost:8765/> and opens a browser at it. It listens
on the loopback address only, so nothing is reachable from the network — not even from another
machine in the same office.

It uses Node.js if you have it and falls back to Python; if you have neither, install
[Node.js](https://nodejs.org) and run it again. Leave the terminal window open while you work,
and press `Ctrl+C` to stop.

> Opening `index.html` directly by double-clicking also mostly works, but the browser blocks
> some requests on `file://` URLs. Use the start script — it takes the same one click.

### 3. Connect GitHub storage

The board saves to `data/board.json` in this repository, and pasted screenshots to
`data/img/`. That's what makes the same board show up on your other computers.

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
2. Scope it to **only this repository**.
3. Under *Repository permissions*, set **Contents: Read and write**.
4. In the board, click **⚙ Settings**, fill in owner / repo / branch, paste the token,
   press **Test connection**, then **Save**.

The token is stored in your browser's local storage and is never committed. Do this once per
computer. Without a token the board still runs, but it keeps everything in that browser and
nothing is shared.

Because the repository is private, the token must belong to an account with access to it —
add colleagues under **Settings → Collaborators** first.

### How saving works

- Every change is written to browser storage immediately, so nothing is lost if you close the tab.
- Changes are pushed to GitHub a couple of seconds after you stop typing; the header shows
  `Syncing…` / `Synced`.
- Press **↻ Sync** to pull the newest version from GitHub and push your changes — do this when
  you sit down at a different computer.
- Newest-wins: when pulling, a remote board with a later `updatedAt` replaces the local one.
  If two people edit at the same time on different machines, the later save wins, so sync
  before and after a work session rather than leaving two tabs open all day.

## Layout

```
index.html        page shell (header, desktop, modals)
css/styles.css    AEM Baltic theme — brand colours are CSS variables at the top
js/app.js         state, rendering, window management, GitHub sync, billing
serve.js          the local server (plain Node, no dependencies)
start.cmd         start it on Windows
start.sh          start it on macOS / Linux
data/board.json   the board itself (jobs, hours, rates, image references)
data/img/         pasted screenshots, one PNG per image
assets/logo.webp  the AEM Baltic logo (also accepts logo.svg or logo.png)
```

### The logo

The header uses `assets/logo.webp`, and will pick up `assets/logo.svg` or `assets/logo.png`
in preference to it if either exists. With none of them present it falls back to a
typographic wordmark, so nothing breaks either way. A light or white version reads best,
because the header sits on the dark ground and the rust of the standard logo is close in
value to the background.

### Adding or renaming clients

Clients live in `data/board.json`. Add another entry to the `clients` array with a unique
`id`, a `name`, and empty `jobs` / `images` arrays, then bump `updatedAt` past the value
your browser holds — or edit the array in the file and press **↻ Sync**.

### Brand colours

`css/styles.css` opens with a `:root` block holding the whole palette, read off the AEM
Baltic branding: `--rust` (`#8B2E1B`, the brush wordmark red, used for title bars),
`--terracotta`, `--orange` and `--amber` from the site's warm range, on the dark
`--ground` / `--dot` halftone field. Every colour in the stylesheet derives from those
tokens, so adjusting them re-themes the board.

The board commits to this one dark look rather than following the viewer's light/dark
setting, which is why each colour is painted explicitly.
