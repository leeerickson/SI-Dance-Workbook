<?php
/**
 * The phone page markup. Everything that comes from the desk is filled in by assets/app.js with textContent.
 *
 * @package RecitalLive
 * @var WP_Post $post   Show.
 * @var array   $config Settings for app.js.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
$rl_json = wp_json_encode( $config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT );
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0f14">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="<?php echo esc_attr( $post->post_title ); ?>">
<title><?php echo esc_html( $post->post_title ); ?></title>
<link rel="manifest" href="<?php echo esc_url( recital_live_url( 'manifest', $post->post_name ) ); ?>">
<link rel="icon" href="<?php echo esc_url( recital_live_asset( 'icon.svg' ) ); ?>" type="image/svg+xml">
<link rel="apple-touch-icon" href="<?php echo esc_url( recital_live_asset( 'icon-192.png' ) ); ?>">
<link rel="stylesheet" href="<?php echo esc_url( recital_live_asset( 'app.css' ) ); ?>">
</head>
<body>
<header class="top">
	<div class="top-row">
		<h1 id="showTitle"><?php echo esc_html( $post->post_title ); ?></h1>
		<span id="conn" class="conn" role="status" aria-live="polite"><span class="dot"></span><span id="connText"><?php esc_html_e( 'Connecting…', 'recital-live' ); ?></span></span>
	</div>
	<label class="other" id="otherWrap" hidden>
		<span class="sr"><?php esc_html_e( 'Other shows', 'recital-live' ); ?></span>
		<select id="otherShows" aria-label="<?php esc_attr_e( 'Other shows', 'recital-live' ); ?>"></select>
	</label>
</header>

<main>
	<div id="offline" class="offline" hidden><?php esc_html_e( 'Offline — showing the last update', 'recital-live' ); ?></div>

	<section id="banner" class="banner" hidden aria-live="polite">
		<div id="msgText" class="msg"></div>
		<div id="countdownWrap" class="countdown" hidden><span id="countdownLabel"><?php esc_html_e( 'Back in', 'recital-live' ); ?></span> <strong id="countdown">0:00</strong></div>
	</section>

	<section id="empty" class="card empty">
		<div class="big-icon" aria-hidden="true">&#9733;</div>
		<h2 id="emptyTitle"><?php esc_html_e( 'The show hasn\'t started yet', 'recital-live' ); ?></h2>
		<p id="emptyText"><?php esc_html_e( 'Keep this page open. It updates by itself when the show begins.', 'recital-live' ); ?></p>
	</section>

	<section id="now" class="card now" hidden>
		<div class="now-head">
			<span class="label"><?php esc_html_e( 'Now', 'recital-live' ); ?></span>
			<span id="state" class="state"></span>
		</div>
		<div id="nowNum" class="num"></div>
		<h2 id="nowDance" class="dance"></h2>
		<div id="nowTitle" class="track"></div>
		<div id="nowClass" class="klass"></div>
		<div class="progress" aria-hidden="true"><div id="bar" class="bar"></div></div>
		<div class="timers">
			<div><span class="t-label"><?php esc_html_e( 'Elapsed', 'recital-live' ); ?></span><span id="elapsed" class="t">0:00</span></div>
			<div class="right"><span class="t-label"><?php esc_html_e( 'Remaining', 'recital-live' ); ?></span><span id="remaining" class="t">0:00</span></div>
		</div>
	</section>

	<section id="next" class="card next" hidden>
		<span class="label"><?php esc_html_e( 'Up next', 'recital-live' ); ?></span>
		<div class="next-row"><span id="nextNum" class="num-sm"></span><div><div id="nextDance" class="dance-sm"></div><div id="nextTitle" class="track-sm"></div></div></div>
	</section>

	<section id="showLeftWrap" class="card slim" hidden>
		<span class="label"><?php esc_html_e( 'Show time left', 'recital-live' ); ?></span>
		<strong id="showLeft" class="t">0:00</strong>
	</section>

	<section id="cues" class="card cues" hidden>
		<span class="label"><?php esc_html_e( 'Cues', 'recital-live' ); ?></span>
		<div id="cueNow" class="cue-now"><span class="cue-type"></span><span class="cue-text"></span></div>
		<div id="cueNextWrap" class="cue-next">
			<span class="cue-next-label"><?php esc_html_e( 'Next', 'recital-live' ); ?></span>
			<span id="cueNext" class="cue-text"></span>
			<span id="cueIn" class="cue-in"></span>
		</div>
		<div id="chips" class="chips" role="group" aria-label="<?php esc_attr_e( 'Show cues for', 'recital-live' ); ?>">
			<button type="button" class="chip" data-type="light" aria-pressed="false"><?php esc_html_e( 'Lighting', 'recital-live' ); ?></button>
			<button type="button" class="chip" data-type="prop" aria-pressed="false"><?php esc_html_e( 'Props', 'recital-live' ); ?></button>
			<button type="button" class="chip" data-type="spot" aria-pressed="false"><?php esc_html_e( 'Spots', 'recital-live' ); ?></button>
			<button type="button" class="chip" data-type="sound" aria-pressed="false"><?php esc_html_e( 'Sound', 'recital-live' ); ?></button>
			<button type="button" class="chip" data-type="stage" aria-pressed="false"><?php esc_html_e( 'Stage', 'recital-live' ); ?></button>
			<button type="button" class="chip" data-type="note" aria-pressed="false"><?php esc_html_e( 'Notes', 'recital-live' ); ?></button>
		</div>
		<ol id="cueList" class="cue-list"></ol>
	</section>

	<section id="props" class="card props" hidden>
		<span class="label"><?php esc_html_e( 'Props', 'recital-live' ); ?></span>
		<div class="props-cols">
			<div><h3><?php esc_html_e( 'This number', 'recital-live' ); ?></h3><ul id="propsNow"></ul></div>
			<div><h3><?php esc_html_e( 'Next number', 'recital-live' ); ?></h3><ul id="propsNext"></ul></div>
		</div>
	</section>

	<section class="card program">
		<span class="label"><?php esc_html_e( 'Running order', 'recital-live' ); ?></span>
		<p id="programEmpty" class="muted"><?php esc_html_e( 'The running order will appear here once the studio sends it.', 'recital-live' ); ?></p>
		<ol id="programList" class="program-list"></ol>
	</section>

	<section id="crewBox" class="card crew" hidden>
		<form id="crewForm" autocomplete="off">
			<label for="crewCode"><?php esc_html_e( 'Crew? Enter the code to see cues and props', 'recital-live' ); ?></label>
			<div class="crew-row">
				<input id="crewCode" type="text" inputmode="text" autocapitalize="off" spellcheck="false" placeholder="<?php esc_attr_e( 'Crew code', 'recital-live' ); ?>">
				<button type="submit" class="btn"><?php esc_html_e( 'Unlock', 'recital-live' ); ?></button>
			</div>
			<p id="crewMsg" class="crew-msg" role="alert"></p>
		</form>
		<div id="crewOn" hidden>
			<p><?php esc_html_e( 'Crew view is on: you can see cues and props.', 'recital-live' ); ?></p>
			<button type="button" id="crewForget" class="btn ghost"><?php esc_html_e( 'Turn off crew view', 'recital-live' ); ?></button>
		</div>
	</section>

	<section class="tools">
		<button type="button" id="installBtn" class="btn" hidden><?php esc_html_e( 'Add to Home Screen', 'recital-live' ); ?></button>
		<p id="iosHint" class="muted" hidden><?php esc_html_e( 'To add this to your Home Screen: tap the Share button, then "Add to Home Screen".', 'recital-live' ); ?></p>
		<button type="button" id="wakeBtn" class="btn ghost" hidden aria-pressed="false"><?php esc_html_e( 'Keep screen on', 'recital-live' ); ?></button>
	</section>
</main>
<script id="rl-config" type="application/json"><?php echo $rl_json; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON with < > & ' " escaped. ?></script>
<script src="<?php echo esc_url( recital_live_asset( 'app.js' ) ); ?>"></script>
</body>
</html>
