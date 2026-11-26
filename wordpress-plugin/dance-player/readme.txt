=== Dance Player ===
Contributors: choreographyworkbook
Tags: dance, choreography, formations, music, rehearsal
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Play Choreography Workbook .dance files on your site: counts, notes, formations, props and music together, like the Workbook Player app.

== Description ==

Dance Player shows a number made in Choreography Workbook on any page or post. Visitors get the same player as the Workbook Player phone app:

* the big count, section and 8-count, with the note for each 8-count and the next one
* speed (50–100% without changing the pitch), count-off, loop an 8-count, and repeat sections with a count-in
* the live formation with props, in audience or dancer view; follow one dancer to see their spot, where they go next and their prop jobs
* the choreography video, if the file includes it, in time with the music
* a 3D view from the audience, curved paths, staggered timing and which way each dancer faces
* film yourself with the camera and watch your run next to the formation (needs https)

Everything runs in the visitor's browser. Files visitors open themselves are never uploaded.

== Using it ==

1. Upload a .dance file to the Media Library (this plugin allows .dance uploads).
2. Add the **Dance Player** block and choose the file. Or use the shortcode:

`[dance_player file="123"]` (Media Library ID) or `[dance_player file="https://example.com/wp-content/uploads/spotlight.dance"]`

Options: `open="no"` hides the "Open a .dance file" button, `width="480"` sets the player's maximum width in pixels.

`[dance_player]` with no file lets visitors open .dance files from their own device.

To include the music, save the share file in Choreography Workbook with "Everything, including music and video". Only post music and video you have the right to share.

== Changelog ==

= 0.2.0 =
* The stage size, spike marks and floor from the file; curved paths and staggered timing; which way each dancer faces; formation notes.
* 3D view from the audience (swipe sideways to change seat).
* Film yourself: record a run with the front camera and watch it next to the formation or the teacher's video, in time with the counts.

= 0.1.0 =
* First version.
