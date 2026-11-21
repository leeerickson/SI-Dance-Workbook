# Choreography Workbook for Windows

A desktop app for dance teachers, choreographers and dancers to build, rehearse, print and share choreography. There's no account or login, and everything is saved on your PC.

## What it does

- **Song library.** Keep many songs, each a project with its own counts, sections, notes, video and formations. Projects can be duplicated or deleted.
- **Counts and notes.** Beat detection finds the tempo and count 1, which you can correct with tap tempo or ±10 ms nudges. Name your sections and write a note for every 8-count. 6-, 12-, 4- and 16-count phrases also work.
- **Rehearse.** Play at 50, 75, 90 or 100% speed with no pitch change. Loop an 8-count, a section or any range, with a "5, 6, 7, 8" count-off and optional clicks. The current count and note show in large type, next to the live formation.
- **Video.** Add a video of the choreography. It stays locked to the music, so mirroring, slowing down and looping apply to it too.
- **Formations.** Drag dancers on a numbered stage. Each formation arrives on a count, and the app warns when dancers come within 2 ft of each other. Each dancer gets their own cue list.
- **Print.** Print the count sheet and formation charts, or save them as a PDF (Ctrl+P, Ctrl+Shift+P).
- **Share.** Save a `.dance` file (Ctrl+S) and send it like any attachment. The other teacher opens it with Ctrl+O, or by double-clicking it if they used the installer.

## The `.dance` file

A `.dance` file is a zip:

```
project.json        counts, sections, notes, dancers, formations, format version
media/audio.<ext>   only when "Everything, including music and video" is chosen
media/video.<ext>   same
```

If the music is left out, the recipient adds their own copy and the app checks that its length matches.

## Running and building

You need Node.js 22. Run each command from the project folder.

```bash
npm install
```

```bash
npm start
```

Build the Windows app on a Windows PC (this gives you an installer and a portable `.exe` in `dist/`):

```bash
npm run dist
```

Build it on Linux. The installer can't be built here because it needs Wine, so this gives you a portable `.exe` and a `.zip`:

```bash
npm run dist:portable
```

To run the automated test, which uses Playwright (on Linux, put `xvfb-run` in front):

```bash
npm test
```

The GitHub workflow in `.github/workflows/windows-build.yml` builds the installer on a Windows runner. Start it from the Actions tab, or push a tag such as `v0.1.0`.

## Where things live

| File | What it is |
| --- | --- |
| `main.js` | Window, menus, file dialogs, printing, reading and writing `.dance` files |
| `preload.js` | The small, fixed set of functions the page can call |
| `app/index.html` | The whole interface: library, rehearse, counts and notes, formations, share and print |
| `app/fonts/` | Bundled fonts (SIL Open Font License), so the app works offline |
| `build/` | Icon and the script that stamps the icon and version details into the `.exe` |

Projects are stored in the app's own folder (`%APPDATA%\Choreography Workbook`). To move to a new PC, save share files with "Everything" and open them on the new one.

## Not done yet

- **Code signing.** Without a signing certificate, Windows SmartScreen shows "Windows protected your PC" the first time someone runs the app. They need to click "More info", then "Run anyway". A certificate costs roughly $100–400 a year.
- **Library backup.** There's no one-click backup or restore of the whole library yet.
- **Automatic updates.**
