# Choreography Workbook for Windows

A desktop app for dance teachers, choreographers and dancers to build, rehearse, print and share choreography. There's no account or login, and everything is saved on your PC.

## What it does

- **Song library.** Keep many songs, each a project with its own counts, sections, notes, video and formations. Projects can be duplicated or deleted, and sorted by recently opened, A to Z, or your own order (drag the cards).
- **Library backup.** Save the whole library, music and videos included, as one `.dancelib` file and restore it on any PC. Restoring adds songs you don't have and updates older copies. A banner reminds you weekly if songs have changed since your last backup (you can turn it off).
- **Counts and notes.** Beat detection finds the tempo and which beat is 1 of the 8-count, and a new project gets sections suggested from the music (Intro, Verse, Chorus, Bridge…). "Suggest from the music" does this again for any song, and shows the list before changing anything. Correct the beat with tap tempo or ±10 ms nudges. Name your sections and write a note for every 8-count. 6-, 12-, 4- and 16-count phrases also work.
- **Rehearse.** Play at 50, 75, 90 or 100% speed with no pitch change. Loop an 8-count, a section or any range, with a "5, 6, 7, 8" count-off and optional clicks. The current count and note show in large type, next to the live formation.
- **Video.** Add a video of the choreography. It stays locked to the music, so mirroring, slowing down and looping apply to it too.
- **Repeat sections.** Pick a section, or a run of sections such as Verse through Chorus, and repeat it 2–10 times or until you stop. You can turn on a count-in before each time.
- **Props.** Add chairs, boxes, benches, tables or anything else, drag them on stage in each formation, and choose who moves each prop (a dancer or the stage crew). The app flags props nobody is moving, movers who end too far from their prop, dancers moving two props at once, and anyone standing on a prop. Prop jobs show on each dancer's cues and in a "who moves what" table on the printout.
- **Formations.** Drag dancers on a numbered stage. Each formation arrives on a count, and the app warns when dancers come within 2 ft of each other or end up off the stage. Each dancer gets their own cue list.
  - **Paths.** See every dancer's path into the formation. Drag the ◆ on a path to curve it (double-click to straighten).
  - **Who moves when.** Everyone together, front row first, back row first, stage right or left first, or one at a time, or set when each dancer starts and arrives. Choose a smooth start and stop or a steady walk.
  - **Facing.** Turn each dancer in 45° steps (front, corners, sides, back). A pointer on each dot shows it, and cues say "facing stage left".
  - **Formation notes.** A note on each formation shows in Rehearse, on the phone and on the printout.
  - **Stage.** Studio, standard, large or gym size, or any size; spike marks every 2–6 ft numbered by 2s, by 1s or in feet; dark, black, grey, wood or white floor, or your own picture.
  - **3D view.** See the stage from the audience. Drag to change your seat; double-click for the centre seat.
  - **Saved classes.** Save a set of dancers as a class ("Jazz Tuesday 4pm") and add it to any number.
- **Print.** Print the count sheet and formation charts, or save them as a PDF (Ctrl+P, Ctrl+Shift+P).
- **Make a video.** Save an MP4 of the formations moving to the music, with the count, the note for each 8-count and the timeline (Share & print tab, or Ctrl+Shift+V). Choose 16:9 landscape or 9:16 portrait, the whole song or some sections, 100/90/75/50% speed (the music keeps its pitch), audience, dancer or 3D view, highlight one dancer and their path, and include the choreography video picture-in-picture. Videos are drawn frame by frame, which is usually faster than real time.
- **Share.** Save a `.dance` file (Ctrl+S) and send it like any attachment. The other teacher opens it with Ctrl+O, or by double-clicking it if they used the installer.
- **Sync by file.** Every number keeps a permanent ID. When a `.dance` file of a number you already have comes back (from a phone or another teacher), opening it updates your copy instead of adding a second one. If it was changed in both places since they last matched, the app asks: replace yours, or keep both. This works without accounts or the internet, and doesn't depend on the devices' clocks agreeing.

## The `.dance` file

A `.dance` file is a zip:

```
project.json        counts, sections, notes, dancers, formations, props, stage, format version
media/audio.<ext>   only when "Everything, including music and video" is chosen
media/video.<ext>   same
```

If the music is left out, the recipient adds their own copy and the app checks that its length matches.

Newer fields (stage size, curved paths, staggered timing, facing, formation notes) are optional, so older copies of the apps still open new files; they show straight paths and everyone moving together.

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
| `app/songcore.js` | Beat, count 1 and section finding, and matching numbers when files come back (sync by file). Shared with the phone app like `stagecore.js` |
| `app/stagecore.js` | Stage maths and drawing shared with the phone player: stage size, paths, timing, facing, 3D view. Edit it here, then run `npm run sync-core` to copy it to `mobile/www/` |
| `app/fonts/` | Bundled fonts (SIL Open Font License), so the app works offline |
| `build/` | Icon and the script that stamps the icon and version details into the `.exe` |

Projects are stored in the app's own folder (`%APPDATA%\Choreography Workbook`). To move to a new PC, use **Back up library** and then **Restore a backup** on the new one.

## Not done yet

- **Code signing.** Without a signing certificate, Windows SmartScreen shows "Windows protected your PC" the first time someone runs the app. They need to click "More info", then "Run anyway". A certificate costs roughly $100–400 a year.
- **Automatic updates.**

## Android player (`mobile/`)

**Workbook Player** is the phone and tablet app (Android and iPhone). It opens `.dance` files and plays them, and it can edit and create numbers too:

- big count, section and 8-count, plus the note for each 8-count and the next one
- speed (25–100% without pitch change), count-off, loop this 8-count, and repeat sections a set number of times with a count-in
- the live formation with props, in audience, dancer or 3D view, on the stage size and floor from the file; "Follow" a dancer for their spot, which way they face, when they start moving, their path to the next spot and their prop jobs, or follow the stage crew
- formation notes from the teacher
- **Film yourself:** prop up the phone, tap Record, and the front camera films your run while the music plays (video only, no microphone). Then tap Watch to see your run next to the formation or the teacher's video, in time with the counts and at any speed. The last 10 runs per song stay on the phone
- **Save a video with counts:** save a filmed run, or the teacher's video (the part chosen under Repeat), as a video with the count, section, 8-count and note drawn on it and the music underneath, at 100, 75, 50 or 25% speed (the music keeps its pitch). It's made in real time, so a 1-minute run at 50% takes 2 minutes. Then the share sheet saves it to Photos or Files, or sends it
- **Edit on the phone or tablet:** tap **Edit**. A toolbar along the bottom opens panels for the song (title, tempo, tap tempo, count 1, counting, sections, suggested sections), formations (when they land, travel, who moves when, notes, spacing check), the selected dancer (name, colour, facing, timing, path), dancers and saved classes, props and who moves them, the stage, and sending the file.
  - On the stage: tap a dancer, then tap where they go, or drag them; on a touch screen the dot rides just above your finger. Drag the ◆ on a path to curve it. Pinch to zoom and drag the floor to pan. Undo and Redo cover every change.
  - Tap the note box to write the note for the 8-count you're on.
  - **New number from a song** in the list starts from music on the phone: the beat, count 1 and sections are found for you.
  - **Send** saves a `.dance` file (with or without the music and video) through the share sheet. Files that come back update the number in place (sync by file, as on the desktop).
  - On tablets (880 px and wider) the player uses two columns.
- speeds down to 25% for slow motion
- the video, if the file includes it, locked to the music, with mirror
- if the file came without music, add your own copy of the song
- the screen stays on while a song is open, and numbers you open are kept on the phone

It's the web page in `mobile/www/` wrapped with Capacitor. To build the APK, run the **Android build** workflow from the Actions tab. It publishes a release with the APK to install. To build it yourself you need Android Studio or the Android SDK, plus Java 17. Run each command from the `mobile/` folder.

```bash
npm ci
```

```bash
npm run sync
```

```bash
cd android && ./gradlew assembleDebug
```

To test the player and the editor in a phone-sized browser (uses Playwright):

```bash
node test/player-test.js path/to/file.dance
```

```bash
node test/editor-test.js
```

Test builds are signed with `android/app/test-signing.keystore`, which is kept in the repository so each build installs over the last one. Before publishing to the Play Store, create a private release key and keep it out of the repository.

## WordPress plugin (`wordpress-plugin/`)

**Dance Player** shows a `.dance` file on a WordPress page, using the same player as the phone apps (`mobile/www`). Add the **Dance Player** block, or the shortcode `[dance_player file="<Media Library ID or URL>"]`. Use `open="no"` to hide the Open button, or leave out `file` so visitors open their own files. The plugin also allows `.dance` uploads to the Media Library.

To build the zip in `dist/`:

```bash
node wordpress-plugin/build.js
```

To test it against a stand-in page (uses PHP and Playwright):

```bash
node wordpress-plugin/test/plugin-test.js
```

The **WordPress plugin** workflow builds the zip, starts a real WordPress site in Docker, uploads the test file, creates pages with the shortcode and the block, tests them in a browser, and publishes a release.
