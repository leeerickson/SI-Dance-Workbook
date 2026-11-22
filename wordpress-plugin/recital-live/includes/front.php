<?php
/**
 * Recital Live: the phone page, its web app manifest, the service worker and the shortcode.
 * These pages don't use the theme: they are small standalone pages made for phones in a dark theatre.
 *
 * @package RecitalLive
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'parse_request', 'recital_live_serve', 1 );

/**
 * Serves /recital/{slug}/, its manifest and /recital/sw.js before WordPress runs its main query.
 * Also handles ?recital_show=slug, ?recital_manifest=slug and ?recital_sw=1 for sites without pretty permalinks.
 *
 * @param WP $wp Current request.
 */
function recital_live_serve( $wp ) {
	$vars = isset( $wp->query_vars ) && is_array( $wp->query_vars ) ? $wp->query_vars : array();
	if ( ! empty( $vars['recital_sw'] ) ) {
		recital_live_send_sw();
		exit;
	}
	if ( isset( $vars['recital_manifest'] ) && '' !== $vars['recital_manifest'] ) {
		recital_live_send_manifest( (string) $vars['recital_manifest'] );
		exit;
	}
	if ( isset( $vars['recital_show'] ) && '' !== $vars['recital_show'] ) {
		recital_live_send_page( (string) $vars['recital_show'] );
		exit;
	}
}

/**
 * Plugin asset URL with a version so phones pick up updates.
 *
 * @param string $file File under assets/.
 * @return string
 */
function recital_live_asset( $file ) {
	return add_query_arg( 'ver', RECITAL_LIVE_VERSION, plugins_url( 'assets/' . $file, RECITAL_LIVE_FILE ) );
}

/**
 * The service worker, served from /recital/sw.js so it can look after every show page.
 */
function recital_live_send_sw() {
	$js    = (string) file_get_contents( RECITAL_LIVE_DIR . '/assets/sw.js' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- local plugin file.
	$shell = array(
		recital_live_asset( 'app.css' ),
		recital_live_asset( 'app.js' ),
		recital_live_asset( 'icon.svg' ),
		recital_live_asset( 'icon-192.png' ),
		recital_live_asset( 'icon-512.png' ),
	);
	$js    = str_replace(
		array( '__RL_SHELL__', '__RL_VERSION__' ),
		array( wp_json_encode( $shell, JSON_UNESCAPED_SLASHES ), wp_json_encode( RECITAL_LIVE_VERSION ) ),
		$js
	);
	status_header( 200 );
	header( 'Content-Type: text/javascript; charset=utf-8' );
	header( 'Cache-Control: no-cache' );
	header( 'Service-Worker-Allowed: ' . recital_live_sw_scope() );
	header( 'X-Content-Type-Options: nosniff' );
	echo $js; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- our own script file.
}

/**
 * Sends a plain "not found" page.
 */
function recital_live_send_404() {
	status_header( 404 );
	nocache_headers();
	header( 'Content-Type: text/html; charset=utf-8' );
	echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
		. esc_html__( 'Show not found', 'recital-live' )
		. '</title><style>body{margin:0;background:#0d0f14;color:#e8eaf0;font:18px/1.5 system-ui,sans-serif;padding:32px 20px;text-align:center}a{color:#ffc857}</style></head><body><h1>'
		. esc_html__( 'We couldn\'t find that show', 'recital-live' )
		. '</h1><p>'
		. esc_html__( 'Check the link you were given, or ask the studio for a new one.', 'recital-live' )
		. '</p><p><a href="' . esc_url( home_url( '/' ) ) . '">' . esc_html( get_bloginfo( 'name' ) ) . '</a></p></body></html>';
}

/**
 * A show's web app manifest, so it can be added to the home screen.
 *
 * @param string $slug Show slug.
 */
function recital_live_send_manifest( $slug ) {
	$post = recital_live_find_show( $slug );
	if ( ! $post ) {
		recital_live_send_404();
		return;
	}
	$title = wp_strip_all_tags( $post->post_title );
	$short = function_exists( 'mb_substr' ) ? mb_substr( $title, 0, 12 ) : substr( $title, 0, 12 );
	$page  = recital_live_url( 'page', $post->post_name );
	$data  = array(
		'name'             => $title,
		'short_name'       => $short,
		'description'      => __( 'Follow the recital live: what\'s on now, what\'s next, and how long to go.', 'recital-live' ),
		'id'               => $page,
		'start_url'        => $page,
		'scope'            => recital_live_pretty() ? $page : recital_live_sw_scope(),
		'display'          => 'standalone',
		'orientation'      => 'portrait',
		'background_color' => '#0d0f14',
		'theme_color'      => '#0d0f14',
		'icons'            => array(
			array(
				'src'     => recital_live_asset( 'icon-192.png' ),
				'sizes'   => '192x192',
				'type'    => 'image/png',
				'purpose' => 'any maskable',
			),
			array(
				'src'     => recital_live_asset( 'icon-512.png' ),
				'sizes'   => '512x512',
				'type'    => 'image/png',
				'purpose' => 'any maskable',
			),
			array(
				'src'     => recital_live_asset( 'icon.svg' ),
				'sizes'   => 'any',
				'type'    => 'image/svg+xml',
				'purpose' => 'any',
			),
		),
	);
	status_header( 200 );
	header( 'Content-Type: application/manifest+json; charset=utf-8' );
	header( 'Cache-Control: no-cache' );
	echo wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON.
}

/**
 * The phone page for a show.
 *
 * @param string $slug Show slug.
 */
function recital_live_send_page( $slug ) {
	$post = recital_live_find_show( $slug );
	if ( ! $post ) {
		recital_live_send_404();
		return;
	}
	$config = array(
		'slug'    => $post->post_name,
		'title'   => $post->post_title,
		'hasCode' => '' !== trim( (string) get_post_meta( $post->ID, '_rl_crew_code', true ) ),
		'api'     => rest_url( 'recital-live/v1/' ),
		'fast'    => ( function () use ( $post ) { $f = recital_live_public_file( $post->post_name ); return $f ? $f['url'] : ''; } )(),
		'sw'      => recital_live_url( 'sw' ),
		'scope'   => recital_live_sw_scope(),
		'page'    => recital_live_url( 'page', $post->post_name ),
		'version' => RECITAL_LIVE_VERSION,
	);
	status_header( 200 );
	header( 'Content-Type: text/html; charset=utf-8' );
	header( 'Cache-Control: no-cache' );
	header( 'X-Content-Type-Options: nosniff' );
	header( 'Referrer-Policy: same-origin' );
	include RECITAL_LIVE_DIR . '/includes/page.php';
}

/**
 * [recital_live show="slug" height="800"]: the phone page in a frame on any page or post.
 *
 * @param array $atts show, height, title.
 * @return string HTML.
 */
function recital_live_shortcode( $atts ) {
	$a    = shortcode_atts(
		array(
			'show'   => '',
			'height' => '800',
			'width'  => '480',
			'title'  => '',
		),
		$atts,
		'recital_live'
	);
	$post = recital_live_find_show( $a['show'] );
	if ( ! $post ) {
		return current_user_can( 'edit_posts' )
			? '<p><strong>' . esc_html__( 'Recital Live: there is no published show with that name. Check the show="" part of the shortcode.', 'recital-live' ) . '</strong></p>'
			: '';
	}
	$height = max( 400, min( 3000, (int) $a['height'] ) );
	$width  = max( 320, min( 1200, (int) $a['width'] ) );
	$title  = '' !== $a['title'] ? $a['title'] : $post->post_title;
	return sprintf(
		'<div class="recital-live-wrap" style="max-width:%1$dpx;margin:1.5em auto"><iframe class="recital-live-frame" src="%2$s" title="%3$s" loading="lazy" style="width:100%%;height:%4$dpx;border:0;border-radius:16px;display:block;background:#0d0f14" allow="screen-wake-lock"></iframe><p style="text-align:center;margin:.5em 0 0"><a href="%2$s">%5$s</a></p></div>',
		$width,
		esc_url( recital_live_url( 'page', $post->post_name ) ),
		esc_attr( $title ),
		$height,
		esc_html__( 'Open on its own page (best on phones)', 'recital-live' )
	);
}
add_shortcode( 'recital_live', 'recital_live_shortcode' );
