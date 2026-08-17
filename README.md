# AEM Baltic — Client Task Board

An interactive idea/to-do board for tracking work per client, with pasted
screenshots, hour logging and a billing summary.

Three clients are set up out of the box: **Bazevics**, **Mandrele** and **Others**.

## What it does

- **Jobs** — type a job into a client column and press Add. Tick the checkbox when it's
  done, click the text to rename it, drag jobs to reorder them or move them to another client.
- **Hours** — every job has an hours field, and every client has an hourly rate (€/h).
  Each column shows open jobs, done-but-not-invoiced jobs, total hours and the amount owed.
- **Screenshots** — click a client column to make it the paste target, then paste a snip with
  `Ctrl+V`. The image becomes a card on that client's board. Dragging image files onto a
  column works too. Click a card to enlarge it and give it a caption.
- **Billing report** — the `€ Billing` button lists done jobs per client with hours and
  amounts, copies a plain-text report to the clipboard, and can mark jobs as invoiced so
  they drop out of the "owed" totals while staying in history.

## Setting it up

### 1. Publish the page

In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**,
pick the branch holding these files and folder `/ (root)`. The board is then at
`https://<owner>.github.io/todolist/`.

You can also just open `index.html` from disk — everything except GitHub sync works.

### 2. Connect GitHub storage

The board saves to `data/board.json` in this repository, and pasted screenshots to
`data/img/`. That's what makes the same board show up on your other computers.

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
2. Scope it to **only this repository**.
3. Under *Repository permissions*, set **Contents: Read and write**.
4. In the board, click **⚙ Settings**, fill in owner / repo / branch, paste the token,
   press **Test connection**, then **Save**.

The token is stored in your browser's local storage and is never committed. Anyone using
the board without a token still sees the data (it is read from the published
`data/board.json`) but cannot save changes back.

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
index.html        page shell (header, board, modals)
css/styles.css    AEM Baltic theme — brand colours are CSS variables at the top
js/app.js         state, rendering, GitHub sync, billing
data/board.json   the board itself (jobs, hours, rates, image references)
data/img/         pasted screenshots, one PNG per image
```

### Adding or renaming clients

Clients live in `data/board.json`. Add another entry to the `clients` array with a unique
`id`, a `name`, and empty `jobs` / `images` arrays, then bump `updatedAt` past the value
your browser holds — or edit the array in the file and press **↻ Sync**.

### Brand colours

`css/styles.css` starts with a `:root` block holding `--brand-navy`, `--brand-steel` and
`--brand-accent`. Replacing those three hex values re-themes the whole board; the current
values are a navy/amber industrial palette and should be swapped for the exact AEM Baltic
brand hex codes when you have them to hand.
