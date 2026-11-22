<?php
/**
 * Recital Live: the show post type, the /recital/ addresses and small shared helpers.
 *
 * @package RecitalLive
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers the show post type and the /recital/ rewrite rules.
 */
function recital_live_register() {
	register_post_type(
		'recital_show',
		array(
			'labels'              => array(
				'name'               => __( 'Shows', 'recital-live' ),
				'singular_name'      => __( 'Show', 'recital-live' ),
				'menu_name'          => __( 'Recital Live', 'recital-live' ),
				'all_items'          => __( 'Shows', 'recital-live' ),
				'add_new'            => __( 'Add show', 'recital-live' ),
				'add_new_item'       => __( 'Add a show', 'recital-live' ),
				'edit_item'          => __( 'Edit show', 'recital-live' ),
				'new_item'           => __( 'New show', 'recital-live' ),
				'search_items'       => __( 'Search shows', 'recital-live' ),
				'not_found'          => __( 'No shows yet.', 'recital-live' ),
				'not_found_in_trash' => __( 'No shows in the Trash.', 'recital-live' ),
			),
			'public'              => false,
			'publicly_queryable'  => false,
			'exclude_from_search' => true,
			'show_ui'             => true,
			'show_in_menu'        => true,
			'show_in_nav_menus'   => false,
			'show_in_rest'        => false,
			'menu_icon'           => 'dashicons-microphone',
			'supports'            => array( 'title' ),
			'rewrite'             => false,
			'query_var'           => false,
			'has_archive'         => false,
		)
	);

	add_rewrite_rule( '^recital/sw\.js$', 'index.php?recital_sw=1', 'top' );
	add_rewrite_rule( '^recital/([^/]+)/manifest\.webmanifest$', 'index.php?recital_manifest=$matches[1]', 'top' );
	add_rewrite_rule( '^recital/([^/]+)/?$', 'index.php?recital_show=$matches[1]', 'top' );

	// Flush once when the rules change (for example after an update), never on every load.
	if ( get_option( 'recital_live_rules' ) !== RECITAL_LIVE_RULES ) {
		flush_rewrite_rules( false );
		update_option( 'recital_live_rules', RECITAL_LIVE_RULES );
	}
}

add_filter(
	'query_vars',
	function ( $vars ) {
		$vars[] = 'recital_show';
		$vars[] = 'recital_sw';
		$vars[] = 'recital_manifest';
		return $vars;
	}
);

/**
 * Finds a show by its slug.
 *
 * @param string $slug     Show slug.
 * @param bool   $any_live True to also accept drafts and private shows (the desktop may publish before the show is live).
 * @return WP_Post|null
 */
function recital_live_find_show( $slug, $any_live = false ) {
	$slug = sanitize_title( (string) $slug );
	if ( '' === $slug ) {
		return null;
	}
	$posts = get_posts(
		array(
			'post_type'              => 'recital_show',
			'name'                   => $slug,
			'post_status'            => $any_live ? array( 'publish', 'private', 'draft', 'pending', 'future' ) : 'publish',
			'posts_per_page'         => 1,
			'no_found_rows'          => true,
			'update_post_term_cache' => false,
			'suppress_filters'       => true,
		)
	);
	return $posts ? $posts[0] : null;
}

/**
 * True when the site uses pretty permalinks, so /recital/{slug}/ works.
 *
 * @return bool
 */
function recital_live_pretty() {
	return '' !== (string) get_option( 'permalink_structure' );
}

/**
 * The address of a show's mobile page, its manifest, or the service worker.
 *
 * @param string $what 'page', 'manifest' or 'sw'.
 * @param string $slug Show slug.
 * @return string
 */
function recital_live_url( $what, $slug = '' ) {
	$slug = rawurlencode( (string) $slug );
	if ( recital_live_pretty() ) {
		switch ( $what ) {
			case 'manifest':
				return home_url( '/recital/' . $slug . '/manifest.webmanifest' );
			case 'sw':
				return home_url( '/recital/sw.js' );
			default:
				return home_url( '/recital/' . $slug . '/' );
		}
	}
	switch ( $what ) {
		case 'manifest':
			return home_url( '/?recital_manifest=' . $slug );
		case 'sw':
			return home_url( '/?recital_sw=1' );
		default:
			return home_url( '/?recital_show=' . $slug );
	}
}

/**
 * The service worker's scope: /recital/ with pretty permalinks, otherwise the site root.
 *
 * @return string Path.
 */
function recital_live_sw_scope() {
	$path = (string) wp_parse_url( home_url( recital_live_pretty() ? '/recital/' : '/' ), PHP_URL_PATH );
	return '' === $path ? '/' : $path;
}

/**
 * Server time in milliseconds.
 *
 * @return int
 */
function recital_live_now_ms() {
	return (int) round( microtime( true ) * 1000 );
}

/**
 * Reads a stored JSON document (program or status) as objects, so {} stays {}.
 *
 * @param int    $post_id Show ID.
 * @param string $key     Meta key.
 * @return object|null
 */
function recital_live_get_json( $post_id, $key ) {
	$raw = get_post_meta( $post_id, $key, true );
	if ( ! is_string( $raw ) || '' === $raw ) {
		return null;
	}
	$data = json_decode( $raw );
	return is_object( $data ) ? $data : null;
}

/**
 * The show's desktop key, made on first use.
 *
 * @param int $post_id Show ID.
 * @return string
 */
function recital_live_key( $post_id ) {
	$key = (string) get_post_meta( $post_id, '_rl_key', true );
	if ( '' === $key ) {
		$key = wp_generate_password( 32, false );
		update_post_meta( $post_id, '_rl_key', $key );
	}
	return $key;
}

/**
 * True when the show appears in the "Other shows" menu. New shows are listed.
 *
 * @param int $post_id Show ID.
 * @return bool
 */
function recital_live_listed( $post_id ) {
	return '0' !== (string) get_post_meta( $post_id, '_rl_listed', true );
}

/**
 * The connection code the desktop app needs: base64 of {"url","show","key"}.
 *
 * @param WP_Post $post Show.
 * @return string
 */
function recital_live_connection_code( $post ) {
	return base64_encode( // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- the desktop app expects base64.
		wp_json_encode(
			array(
				'url'  => untrailingslashit( home_url() ),
				'show' => $post->post_name,
				'key'  => recital_live_key( $post->ID ),
			),
			JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
		)
	);
}

/**
 * "12 seconds ago", "3 minutes ago" or "Never" for the last status from the desk.
 *
 * @param int $post_id Show ID.
 * @return string
 */
function recital_live_last_update_text( $post_id ) {
	$at = (int) get_post_meta( $post_id, '_rl_received_at', true );
	if ( $at <= 0 ) {
		return __( 'Never', 'recital-live' );
	}
	$s = max( 0, (int) floor( ( recital_live_now_ms() - $at ) / 1000 ) );
	if ( $s < 60 ) {
		/* translators: %d: number of seconds */
		return sprintf( _n( '%d second ago', '%d seconds ago', $s, 'recital-live' ), $s );
	}
	$m = (int) floor( $s / 60 );
	if ( $m < 60 ) {
		/* translators: %d: number of minutes */
		return sprintf( _n( '%d minute ago', '%d minutes ago', $m, 'recital-live' ), $m );
	}
	$h = (int) floor( $m / 60 );
	if ( $h < 48 ) {
		/* translators: %d: number of hours */
		return sprintf( _n( '%d hour ago', '%d hours ago', $h, 'recital-live' ), $h );
	}
	$d = (int) floor( $h / 24 );
	/* translators: %d: number of days */
	return sprintf( _n( '%d day ago', '%d days ago', $d, 'recital-live' ), $d );
}
