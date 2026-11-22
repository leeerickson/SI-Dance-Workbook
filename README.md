# Choreography Workbook for Windows

A desktop app for dance teachers, choreographers and dancers to build, rehearse, print and share choreography. There's no account or login, and everything is saved on your PC.

## What it does

- **Song library.** Keep many songs, each a project with its own counts, sections, notes, video and formations. Projects can be duplicated or deleted.
- **Counts and notes.** Beat detection finds the tempo and count 1, which you can correct with tap tempo or ±10 ms nudges. Name your sections and write a note for every 8-count. 6-, 12-, 4- and 16-count phrases also work.
- **Rehearse.** Play at 50, 75, 90 or 100% speed with no pitch change. Loop an 8-count, a section or any range, with a "5, 6, 7, 8" count-off and optional clicks. The current count and note show in large type, next to the live formation.
- **Video.** Add a video of the choreography. It stays locked to the music, so mirroring, slowing down and looping apply to it too.
- **Repeat sections.** Pick a section, or a run of sections such as Verse through Chorus, and repeat it 2–10 times or until you stop. You can turn on a count-in before each time.
- **Props.** Add chairs, boxes, benches, tables or anything else, drag them on stage in each formation, and choose who moves each prop (a dancer or the stage crew). The app flags props nobody is moving, movers who end too far from their prop, dancers moving two props at once, and anyone standing on a prop. Prop jobs show on each dancer's cues and in a "who moves what" table on the printout.
- **Formations.** Drag dancers on a numbered stage. Each formation arrives on a count, and the app warns when dancers come within 2 ft of each other. Each dancer gets their own cue list.
- **Print.** Print the count sheet and formation charts, or save them as a PDF (Ctrl+P, Ctrl+Shift+P).
- **Make a video.** Save an MP4 of the formations moving to the music, with the count, the note for each 8-count and the timeline (Share & print tab, or Ctrl+Shift+V). Choose 16:9 landscape or 9:16 portrait, the whole song or some sections, 100/90/75/50% speed (the music keeps its pitch), audience or dancer view, highlight one dancer and their path, and include the choreography video picture-in-picture. Videos are drawn frame by frame, which is usually faster than real time.
- **Share.** Save a `.dance` file (Ctrl+S) and send it like any attachment. The other teacher opens it with Ctrl+O, or by double-clicking it if they used the installer.

## The `.dance` file

A `.dance` file is a zip:

```
project.json        counts, sections, notes, dancers, formations, props, format version
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

## Android player (`mobile/`)

**Workbook Player** is a play-only Android app. It opens `.dance` files and plays them, with no editing:

- big count, section and 8-count, plus the note for each 8-count and the next one
- speed (50–100% without pitch change), count-off, loop this 8-count, and repeat sections a set number of times with a count-in
- the live formation with props, in audience or dancer view; "Follow" a dancer for their spot, where they go next and their prop jobs, or follow the stage crew
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

To test the player in a phone-sized browser (uses Playwright):

```bash
node test/player-test.js path/to/file.dance
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

## Recital Show Player (`show-player/`)

A separate desktop app (Windows and Mac) that runs the music and video for a recital.

- **Playlist.** Add music and video files with the button or by dragging them in. Drag rows to change the order at any time, even during the show. Saved as a `.recital` file. Files are stored with full paths and paths relative to the show file, so a show folder can move to another computer. The show is also autosaved, with rolling backups.
- **GO and transitions.** Each song chooses what happens when it ends: **Wait for GO** (stops and waits for GO or Space), **Straight on** (the next song starts with no gap), or **Crossfade** (blends into the next song over the seconds you set). **Fade to next** (F) crossfades into the next song straight away. **Fade out** (Esc) fades out and waits. **Stop** (Shift+Esc) stops at once and stands by on the same song. A double press of GO can't skip a song, and GO does nothing while a song is playing. When nothing is playing, **drag on the waveform** to choose where GO starts the song (the GO button shows "From 1:23"; R goes back to the top). **Restart** (R) plays the song again from the top; after a song has ended, R stands it by so GO plays it again. A played song is dimmed, and its **Play this again** button stands it by. **Reset show** marks every song as not played and stands by on the first, for a second performance.
- **Even volume.** Every file's loudness is measured (EBU R128 / LUFS) and played at the same target level (−16 LUFS by default). A safety limiter stops anything from getting too loud. There's also a 5-band EQ, a rumble filter, a 3-band compressor, master level, balance and left/right trims.
- **Main screen built for the show.** The cue boxes sit right under the timers, with a big next-cue countdown that glows amber shortly before each cue. The current-song panel's edge is green while playing, amber standing by and purple paused. Master volume, meters, pre-show music and the phone message are in the Desk at the top right. On laptop screens (1366×768) everything that matters fits without scrolling; on big screens the important text gets bigger.
- **LCARS mode** (an Easter egg, at the bottom of the Settings sections): a starship-console look with black panels, curved coloured frames, pill buttons and an ENGAGE button. Everything works the same; press it again to switch back.
- **Settings in sections:** Output & level, Volume, Tone & width, Playback, Phones, Streaming and Reliability.
- **Recommended settings.** Every sound setting has a ▲ mark at the recommended value and says when it's set there. **Use recommended sound** resets them all except master, balance and trims, which suit your room. The **master volume** is also on the main screen (double-click it for 0 dB).
- **Skip silence.** New songs start where the music starts and end where it ends, skipping silence at either end. **Skip silence** and **Whole song** in the song details do it by hand.
- **Spatial enhancer.** Widens the stereo picture (Settings → Spatial enhancer). Width runs from 0% (mono, for a PA with one speaker or speakers far apart) through 100% (unchanged) to 200%. **Keep bass centred** stops the low end from being widened, so it keeps its punch. The speaker tests aren't affected by it.
- **Timers and waveform.** Played, left in the song (amber under 30 s, red under 10 s), left in the show, and the clock time the show should end. The waveform shows the playhead, cue markers, trimmed parts and the crossfade zone.
- **Cues.** Add lighting, prop, spot, sound, stage or note cues at any time. Press C during the song (a **New cue** box opens with the time already set: type what to call, Tab changes the type, Enter saves, Esc cancels), double-click the waveform, or type a time. **Cue now** flashes when a cue arrives, and **Next cue** counts down to the next one, turning amber shortly before it.
- **Up next** shows the next dance and how it will start. **Props** shows this number's and the next number's props. Props can be hidden per song.
- **Pre-show and intermission music.** A second playlist with loop and shuffle and its own volume. B plays or fades it, and GO fades it out when the show starts.
- **Hot sounds.** Eight buttons (keys 1–8) for sound effects and voice-overs. They play over the music, and the music ducks while they play.
- **Preflight check** (Ctrl+K). Checks the sound output, that every file is there and plays, files that changed since they were measured, cues outside the song, video screens, battery, sleep prevention, disk space, memory and computer load, the phone connection, and unsaved changes. "Find missing files…" searches a folder for them.
- **Test and calibrate** (Ctrl+T). Pink noise, tones and a sweep on the left, right or both speakers, a polarity check, and a loudness check that plays the loudest 20 seconds of a song. To level the PA, a microphone listens to pink noise played at show loudness. Type a sound-meter reading once to calibrate it in dB, then use **Auto-level** to set the master level to your target (85 dB by default).
- **Sound output** is chosen in Settings. If that device disconnects mid-show, sound moves to the system default and moves back when the device returns.
- **Video** plays in a preview and on the screen you choose with **Video output**: a list of the connected screens, with **Identify screens** to flash a big number on each one. On a projector or second screen the video fills it; on the main screen it opens as a window. The app remembers the screen, can move the video to another screen without stopping it, and offers to move it back if a projector is unplugged and plugged in again.
- **Live streaming (Streaming by StreamingIdiot).** Settings → Streaming sends the show live to your StreamingIdiot account, to **YouTube** (choose YouTube and paste only the stream key, with step-by-step instructions and a button to open YouTube Studio), or to any service that gives an RTMP address: the sound the audience hears (taken as exact samples from the sound engine, so it can't click or drop out when the computer is busy), with the video when a number has one (with "Now performing" over the start) and an animated title card the rest of the time: stage lights, your studio logo, the show title, the dance now on, up next, a progress line and the intermission countdown. Settings → Streaming → Stream picture chooses the logo, title and colour, with a live preview. It runs at low priority so the show comes first, and reconnects by itself if the internet drops. The top bar shows LIVE and the time. Uses the bundled ffmpeg.
- **Phones.** Paste the connection code from the Recital Live WordPress plugin, and the app sends the running order, timers, cues and props. It never waits for the website: if the site is slow or offline, the show carries on and the app retries.
- **Built not to stop.** If the page crashes or hangs, it reloads and carries on playing from where it was. If the whole app closes mid-show, the next start stands by on that song. A stuck file is restarted. Audio keeps running when the window is minimised or covered. The computer is kept awake, quitting while music plays asks first, and everything is logged (File → Show log folder). A small graph in the top bar shows CPU, the app's own load, memory and any delays. Also: if the page crashes three times in three minutes it stands by instead of carrying on, so a bad file can't crash it in a loop. A sound card that stops responding is woken up, with a one-click restart if that fails. A warning shows when another window has the keyboard (so Space wouldn't work). **Copy all files into the show folder** (File menu, or Settings → Reliability) removes any dependence on USB sticks or network drives, and preflight warns about files on them. **Software drawing** helps on computers whose graphics driver misbehaves. Old logs are cleared after 30 days. The video window is watched too: if it stops showing frames while a video plays, the picture is reconnected within about three seconds.

Run it, test it, and build it from the `show-player/` folder (the test needs ffmpeg, and on Linux, `xvfb-run` in front):

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

```bash
npm run dist
```

The **Recital Show Player build** workflow tests the app on Windows and Mac, builds the installer and the `.dmg`, and publishes a release. The protocol between the app and WordPress is described in `show-player/PROTOCOL.md`.

## Recital Live WordPress plugin (`wordpress-plugin/recital-live/`)

A plugin that gives each show its own page for phones at `https://your-site/recital/<show>/`. Teachers, parents, techs and prop people use it to follow the show: what's on now, with count-up and countdown timers, what's next, the show time left, messages and the intermission countdown, and the full running order. With the show's **crew code**, it also shows cues (with filters for Lighting, Props, Spots, Sound, Stage and Notes) and props. The page can be added to the home screen as an app and keeps showing the last update if the signal drops. An **Other shows** menu switches between shows. The shortcode `[recital_live show="<show>"]` puts it on any page.

In WordPress, go to **Recital Live → Shows → Add New**. Set the link name and an optional crew code, publish, and copy the **connection code** into the desktop app's Settings.

```bash
node wordpress-plugin/build-recital-live.js
```

```bash
node wordpress-plugin/test/recital-live-test.js
```

The **Recital Live plugin** workflow builds the zip, tests it, tests it again on a real WordPress site in Docker, and publishes a release.
