# Class Board

An interactive whiteboard for teachers: handwriting with a Wacom pen and real
pressure, geometric shapes, highlighters, a continuous ribbon of A4 sheets and
export of the lesson to PDF. Collaboration runs through a **local server** the
teacher starts themselves — no cloud and no external services.

The interface speaks **English and Ukrainian**; the language is picked in the
top bar and remembered per browser.

## For teachers

If you are not going to touch the code, follow the plain-language guide instead:
**[docs/SETUP.md](docs/SETUP.md)** ([українською](docs/SETUP.uk.md)). It needs no
terminal typing and no administrator rights: `Install.command` on macOS or
`Install.bat` on Windows downloads everything into the project folder, and the
board is started afterwards by double-clicking `Start Board`.

### Handing it out

```bash
npm run package        # class-board.zip, about 150 KB
```

The archive holds the tracked files only — no `node_modules`, no build output,
no portable runtime — and keeps the executable bit on `Install.command`, without
which a double-click would do nothing. Send it however you like, or publish the
repository and let people use **Code → Download ZIP**: the result is the same.

Only `ws` is a runtime dependency; everything the client uses is bundled into
`dist` at build time and lives in `devDependencies`. The installer prunes those
once the build is done, which leaves about 200 KB in `node_modules` instead of
140 MB.

## Quick start

```bash
npm install
npm start          # builds the client and starts the server
```

`npm run setup` does the same as the graphical installer: it fetches a portable
Node into `.runtime` when the system has none, installs, builds and writes the
launchers. Useful on a machine where you would rather not install Node at all.

The terminal prints the links:

```
  Host (full rights):
    http://192.168.0.10:4321/?key=a1b2c3d4

  Participants (give this link to the class):
    http://192.168.0.10:4321/
```

The teacher opens the first link, the class opens the second. Everyone has to
be on the same local network (the school Wi-Fi). The class link is also
available from the "Invite" button inside the app.

The port and the host key come from the environment:

```bash
PORT=8080 BOARD_KEY=lesson2024 npm start
```

For development use `npm run dev`; it starts **both** the client (Vite on 5173)
and the collaboration server on 4321. Running `npm run dev:client` alone gives
you the interface without a server, and the board then works offline.

## Access from another network

If pupils are at home rather than on the school Wi-Fi:

```bash
npm run share
```

This starts the server together with a public tunnel and prints a second pair
of links. The board still lives on the teacher's computer; it merely becomes
reachable from outside. Two ways are tried in turn:

1. **Cloudflare quick tunnel** — needs `cloudflared` installed, gives an address
   like `https://calm-river-1234.trycloudflare.com`.
2. **localhost.run over SSH** — needs nothing at all: `ssh` ships with macOS,
   Linux and Windows 10 and later. The address looks like
   `https://f91d38a751c261.lhr.life`.

If the first way fails, the second takes over automatically and the terminal
says which one worked and why the other did not. Pin one with
`BOARD_TUNNEL=cloudflare` or `BOARD_TUNNEL=ssh`.

Installing cloudflared is optional:

```bash
brew install cloudflared                        # macOS
winget install --id Cloudflare.cloudflared      # Windows
# Linux: https://github.com/cloudflare/cloudflared/releases
```

Whatever address a tunnel reports is checked before it is shown: the board asks
it for `/api/info` and only prints it if this very board answers. Both services
mention their own hosts in their greeting — cloudflared names
`api.trycloudflare.com` in its failure message, localhost.run links to its
dashboard — and handing out one of those is worse than handing out nothing.

Worth knowing:

- **The address lives as long as the command runs**, and it is new every time.
  For a permanent one there is **Tailscale Funnel**: free, and the address
  survives restarts. Install Tailscale and run `tailscale funnel 4321` in
  another terminal — pupils still need nothing.
- **Providers block Cloudflare quick tunnels fairly often.** When that happens
  the terminal prints what cloudflared said and falls back to SSH. You can check
  it yourself in one line:

  ```bash
  curl -m 10 -o /dev/null -w '%{http_code}\n' https://api.trycloudflare.com/
  ```

  A timeout there while `https://www.cloudflare.com/` answers means the block is
  on the network, not in the board.
- **The link is the pass.** It is random and unlisted, but anyone holding it can
  join. Do not show the host link on screen: it grants full rights. The browser
  strips the key from the address bar, so a shared screen will not reveal it.
- **All traffic goes through the teacher's computer** and through a third-party
  relay. Close the laptop and the lesson stops. If you need a permanent address
  and independence from that machine, the same `server/` runs unchanged on any
  VPS.
- If you open the board to an audience you do not know, set new participants to
  view-only — the switch is in the participants panel.

## Paper

The sheet is never pure white — a whole lesson spent looking at `#ffffff` is
tiring and blows out on a projector. The **Paper** button in the toolbar (host
only) opens the settings:

- **Tint** — cream, light blue or a neutral off-white.
- **Ruling** — plain, grid, lines or dots, with the **pitch in millimetres**,
  so a 5 mm grid is really 5 mm on the printed page.
- **Margin** — an unruled border around the sheet. The ruling stops at it and
  the ruled area is outlined, the way a school notebook is: a grid running into
  the very edge looks like a spreadsheet, and there is nowhere left for a
  heading.
- **Paper grain** — an optional faint texture. On screen it is drawn one tile
  pixel per device pixel, so it never shimmers or moirés while zooming.

The paper is one setting for the whole board rather than a property of each
sheet: nobody wants page three to be blue. All of it survives into the PDF —
the tint and the ruling as vectors, the grain as a single image shared by every
page.

## Pages

The board is a continuous ribbon of portrait **A4** sheets running one below
another. Scroll it with the wheel or two fingers; sheet numbers are printed in
the gaps, and the numbers in the bottom bar jump the ribbon to a sheet.

One blank sheet always waits at the bottom: as soon as something lands on the
last one, a new page appears below it, so the notebook never runs out in the
middle of an explanation. The server creates it, which means it also works when
a pupil — who may not add pages — writes to the end.

The identifier of a new page is derived from the document state rather than
generated at random. A client that lost its connection therefore names the next
page exactly as the server would, and reconnecting does not duplicate it.

Sheets carry no styling of their own — how the paper looks is described once in
the board settings, so the order of pages can change freely.

Ink only goes on paper: in the gap between sheets and in the margins the pen
stays deliberately silent, or the ink would land outside the page and never
appear on the board. The cursor stops being a crosshair in those places.

Pages are only ever added automatically. If you erase everything, the spare
empty sheets remain — the host can delete them. They never reach the PDF.

## Participant rights

| Role | May |
| --- | --- |
| **Host** | everything: edit any object, manage pages, hand out rights, freeze the board, disconnect participants |
| **Can write** | draw and edit **their own** objects |
| **View only** | watch |

The host chooses the role newcomers get; the default is "can write". Rights are
checked on the server, not only in the interface: authorship cannot be forged
and other people's work cannot be erased from the browser console.

The host also has:

- **Freeze** — only they can write, which helps while explaining;
- **Follow mode** — everyone's ribbon is pulled to the host's sheet.

## Tools

| Key | Tool |
| --- | --- |
| `V` | select |
| `P` / `B` | pen |
| `H` | highlighter |
| `E` | eraser |
| `T` | text |
| `R` `O` `L` `A` | rectangle, ellipse, line, arrow |
| `Ctrl+V` | paste an image or text from the clipboard |
| `Space` (held) | pan |
| Wheel | scroll the ribbon; with `Ctrl`, zoom |

`Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, `Ctrl+A` selects everything on the
page, `Ctrl+D` duplicates, `Del` deletes, `Ctrl+0` fits to the screen. While
drawing shapes, `Shift` keeps them regular and `Alt` builds from the center.

A selection can be moved, resized by eight handles, rotated, recolored, filled,
made thicker or more transparent, and moved between layers.

### Eraser

The eraser has two modes, switched in its panel:

- **Whole object** — removes whatever it touches: a stroke, a shape, a caption,
  an image. The back end of a Wacom pen works the same way.
- **Part of it** — cuts out handwriting where you drag, and the rest of the
  stroke stays in place as separate pieces. Shapes, text and images are left
  alone: dragging an eraser next to a diagram without destroying it matters
  more than removing that diagram in one stroke.

## Pen and trackpad

- Pressure is read from `PointerEvent.pressure`, so line thickness changes
  along a stroke. A mouse or touchpad gets pressure simulated from the speed of
  the movement, which keeps the line alive without a tablet.
- **Every** intermediate point of a frame is collected through
  `getCoalescedEvents()`: a tablet is sampled hundreds of times per second, and
  without this the line would look faceted.
- **The back end of a stylus erases** — no need to switch tools.
- Touches are ignored while the pen is near the tablet. Finger drawing is off by
  default and is enabled by a checkbox in the pen panel.
- A single tap leaves a dot instead of disappearing: for short strokes the end
  taper is shortened, or it would eat the whole mark.
- Smoothing comes from `perfect-freehand`: a stroke is built as a closed outline
  of varying width, which is why a highlighter does not darken where it crosses
  itself.

**MacBook trackpad (Force Touch).** The web has no standard access to trackpad
pressure: `PointerEvent.pressure` always reports 0.5 for it. The real force is
exposed only by non-standard WebKit events, that is **Safari on macOS** — there
the board uses them and a "Trackpad pressure" switch appears in the pen panel.
Chrome, Edge and Firefox have no such API (verified), and drawing with a
trackpad there keeps the pressure simulated from movement speed, which works
everywhere and looks decent for handwriting.

## Images and text

An image can be inserted three ways: the toolbar button, dropping a file onto
the board, or `Ctrl+V`. A pasted image is selected right away, so it can be
moved, rotated and dragged by its corners — the aspect ratio is preserved by
itself, and `Shift` resizes freely.

Large pictures are scaled down to 1600 pixels on the longest side and
recompressed: photos into JPEG, images with transparency into PNG. The document
travels over the network and lands on disk as a whole, so it must not be
inflated with phone-sized originals.

`Ctrl+V` with text creates a caption. Font size and color are set in the "Text"
tool panel before pasting and can be changed on a selected caption at any time,
in the same place as color and thickness for everything else.

## Export

| Mode | What you get |
| --- | --- |
| **PDF — all pages** | vector: lines stay lines, the file is small, the page is exactly A4 |
| **PDF — current page** | the same, one page |
| **PDF — as on screen** | raster, pixel for pixel, when absolute fidelity matters |
| **PNG — current page** | an image at double resolution (1588x2246) |

The tint, the ruling, the margins and the grain all come out exactly as they
look on screen.

Empty pages stay out of the file, including the spare sheet that always waits at
the bottom. Choosing "current page" exports it even when empty: that is a
deliberate choice.

Captions in a vector PDF are rasterised: the built-in PDF fonts cover Latin
only, and embedding a TTF for a few labels would add hundreds of kilobytes to
every file.

## If the connection drops

The nastiest case is the host losing the internet and coming back on a
different network. No work is lost:

- **The board lives on the host's computer.** The server keeps the document in
  memory, writes it to `.board-sessions/room.json` every couple of seconds and
  always saves on shutdown. Changing networks does not touch the server, and
  the host's browser talks to `localhost` and never notices the drop — which is
  why the host should open the board through the `localhost` link rather than a
  local-network address.
- **Nothing drawn offline disappears.** If the connection does drop, the client
  keeps working on its own and queues everything it did; the status line shows
  how many actions are still unsent. As soon as the connection returns, the
  queue is replayed on top of the server state and sent. Pages created offline
  land in their proper places.
- **Participants only need to rejoin.** On connecting, each of them receives a
  full snapshot and sees the board exactly as it now is, including everything
  drawn while they were away.

One caveat about the tunnel: if `cloudflared` survived the network change the
address stays; if the process restarted, the address is new and the link has to
be sent out again.

## How it is built

```
shared/doc.js        the document reducer, shared by client and server
server/room.js       room state, permissions, broadcasting
server/tunnel.js     public tunnel: cloudflared, or SSH as a fallback
server/index.js      HTTP (serves the built client) plus WebSocket
src/i18n/            English and Ukrainian message sets
src/model/           types, store with undo history, geometry, ribbon layout
src/render/          paper look, stroke outlines and canvas drawing
src/input/           move, resize, rotate, eraser, image preparation, Force Touch
src/net/session.ts   network session with reconnection
src/export/pdf.ts    vector and raster export
```

Everything changes through operations only (`add`, `update`, `remove`,
`clearPage`, …). The client applies an operation immediately and sends it to the
server; the server checks the rights, applies it and broadcasts it to everyone
else. Undo works on a local stack of inverse operations, so each person undoes
only their own work.

Unfinished strokes and cursors travel on a separate live channel and never enter
the document, which is how participants see a line while it is still being
drawn.

Drawing happens in two layers: finished objects are cached in their own canvas
and redrawn only when the scene or the camera changes, while the current stroke,
the selection and other people's cursors are painted on top every frame.

Element coordinates stay local to their page. The ribbon exists only on screen:
a page's offset is added while drawing and while handling input, so the document
does not depend on the order of sheets and export needs no special cases.

## Tests

```bash
npm test             # everything
npm run test:logic   # history, geometry, transforms, strokes, PDF
npm run test:server  # syncing, role rights, reconnection, persistence
npm run test:tunnel  # address parsing, decoy links, missing tools, drops, timeouts
npm run test:browser # pen, dots, automatic pages, losing and regaining the link
npm run typecheck
```

The browser test starts Chrome and a real server and plays the worst case from
end to end. If Chrome is missing or the client is not built, it says so and does
not count as a failure.

## Known limits

- The partial eraser only cuts handwriting; shapes, text and images are removed
  whole.
- Empty pages left behind after erasing are not cleaned up automatically.
- Images are stored inside the document, so a board with dozens of photos gets
  heavy.
- Paper grain adds roughly 150 KB to a PDF: it is one image shared by every
  page, but grain does not compress well.
- A free tunnel gets a new address on every start, and all traffic goes through
  the teacher's computer.
- Trackpad pressure is available only in Safari; no such API exists in other
  browsers.
