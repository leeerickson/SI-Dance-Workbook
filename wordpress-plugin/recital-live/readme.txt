=== Recital Live ===
Contributors: choreographyworkbook
Tags: dance, recital, live, show, theatre
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Follow a recital live on your phone: what's on now, what's next, timers, and cues and props for the crew.

== Description ==

Recital Live works with the Recital Show Player desktop app. While the show runs, the desktop sends what's playing to your site, and anyone with the link can follow along on their phone:

* the dance on stage now, its music and class, and its number in the running order
* how long it has been going and how long is left, ticking live
* what's up next, and how much of the whole show is left
* messages from the desk, like "Intermission — 15 minutes", with a countdown
* the full running order, with finished numbers dimmed

Crew (techs, teachers, prop people) can type a crew code to also see:

* the current lighting, spot, sound, stage and prop cues, the next cue with a countdown, and the cues coming up
* filters so each department only sees its own cues
* the props for this number and the next one

The phone page is made for a dark theatre: dark, big and easy to read. It can be added to the Home Screen, keeps the screen on if you ask it to, and keeps showing the last update if the signal drops.

== Using it ==

1. Go to **Recital Live → Add show**, give the show a name, and click **Publish**.
2. Optional: set a **crew code** so only crew see cues and props.
3. Copy the **connection code** and paste it into the Recital Show Player desktop app.
4. Share the **link for phones** (it looks like `https://yoursite/recital/spring-2027/`). A QR code on the program or a sign in the lobby works well.

To put the live view on a normal page or post, use the shortcode `[recital_live show="spring-2027"]`. Options: `height="800"`, `width="480"`.

Untick **Listed** to keep a show out of the "Other shows" menu on the phone page.

If the link for phones says "not found", go to **Settings → Permalinks** and click **Save Changes** once.

== Privacy ==

Recital Live doesn't use cookies or track visitors. A crew code typed on a phone is remembered on that phone only.

== Changelog ==

= 0.2.0 =
* Much lighter on the web host with many viewers: each update from the desk is also saved as a small file that phones read directly. Phones check in with WordPress once a minute instead of every two seconds. Crew (with the crew code) are unchanged.

= 0.1.0 =
* First version.
