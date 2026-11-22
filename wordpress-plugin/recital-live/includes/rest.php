<?php
/**
 * Recital Live: the REST API the desktop app writes to and phones read from.
 * See show-player/PROTOCOL.md in the Choreography Workbook repository.
 *
 * @package RecitalLive
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'rest_api_init', 'recital_live_rest_routes' );

/**
 * Registers the routes under recital-live/v1.
 */
function recital_live_rest_routes() {
	$ns   = 'recital-live/v1';
	$slug = '(?P<slug>[^/]+)';

	register_rest_route(
		$ns,
		'/ping',
		array(
			'methods'             => 'GET',
			'callback'            => 'recital_live_rest_ping',
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		$ns,
		'/shows',
		array(
			'methods'             => 'GET',
			'callback'            => 'recital_live_rest_list',
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		$ns,
		'/shows/' . $slug,
		array(
			'methods'             => 'GET',
			'callback'            => 'recital_live_rest_get',
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		$ns,
		'/shows/' . $slug . '/program',
		array(
			'methods'             => 'POST',
			'callback'            => 'recital_live_rest_post_program',
			'permission_callback' => 'recital_live_rest_check_key',
		)
	);
	register_rest_route(
		$ns,
		'/shows/' . $slug . '/chat',
		array(
			'methods'             => 'POST',
			'callback'            => 'recital_live_rest_post_chat',
			'permission_callback' => 'recital_live_rest_check_chat',
		)
	);
	register_rest_route(
		$ns,
		'/shows/' . $slug . '/status',
		array(
			'methods'             => 'POST',
			'callback'            => 'recital_live_rest_post_status',
			'permission_callback' => 'recital_live_rest_check_key',
		)
	);
}

/**
 * Lets browsers on other sites send the crew code header when reading.
 */
add_filter(
	'rest_allowed_cors_headers',
	function ( $headers ) {
		$headers[] = 'X-Recital-Code';
		$headers[] = 'X-Recital-Key';
		return $headers;
	}
);

/**
 * A JSON response that phones and proxies must never cache.
 *
 * @param array|object $data   Body.
 * @param int          $status HTTP status.
 * @return WP_REST_Response
 */
function recital_live_response( $data, $status = 200 ) {
	$res = new WP_REST_Response( $data, $status );
	$res->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0' );
	$res->header( 'Pragma', 'no-cache' );
	return $res;
}

/**
 * GET /ping.
 *
 * @return WP_REST_Response
 */
function recital_live_rest_ping() {
	return recital_live_response(
		array(
			'ok'         => true,
			'plugin'     => 'recital-live',
			'version'    => RECITAL_LIVE_VERSION,
			'server_now' => recital_live_now_ms(),
		)
	);
}

/**
 * GET /shows: listed, published shows for the "Other shows" menu.
 *
 * @return WP_REST_Response
 */
function recital_live_rest_list() {
	$posts = get_posts(
		array(
			'post_type'              => 'recital_show',
			'post_status'            => 'publish',
			'posts_per_page'         => 200,
			'orderby'                => 'title',
			'order'                  => 'ASC',
			'no_found_rows'          => true,
			'update_post_term_cache' => false,
			'suppress_filters'       => true,
		)
	);
	$shows = array();
	foreach ( $posts as $p ) {
		if ( '' === $p->post_name || ! recital_live_listed( $p->ID ) ) {
			continue;
		}
		$shows[] = array(
			'slug'  => $p->post_name,
			'title' => $p->post_title,
			'url'   => recital_live_url( 'page', $p->post_name ),
		);
	}
	return recital_live_response( array( 'shows' => $shows ) );
}

/**
 * Permission check for the desktop's POSTs: unknown show → 404, wrong key → 403.
 *
 * @param WP_REST_Request $request Request.
 * @return true|WP_Error
 */
function recital_live_rest_check_key( $request ) {
	$post = recital_live_find_show( $request['slug'], true );
	if ( ! $post ) {
		return new WP_Error( 'recital_no_show', __( 'There is no show with that name on this site.', 'recital-live' ), array( 'status' => 404 ) );
	}
	$stored = (string) get_post_meta( $post->ID, '_rl_key', true );
	$given  = (string) $request->get_header( 'x_recital_key' );
	if ( '' === $stored || '' === $given || ! hash_equals( $stored, $given ) ) {
		return new WP_Error( 'recital_bad_key', __( 'The desktop key is not right. Copy the connection code from the show in WordPress again.', 'recital-live' ), array( 'status' => 403 ) );
	}
	$request->set_param( '_rl_post_id', $post->ID );
	return true;
}

/**
 * Checks the POSTed body: a JSON object no bigger than 512 KB.
 *
 * @param WP_REST_Request $request Request.
 * @return object|WP_Error The decoded object.
 */
function recital_live_read_body( $request ) {
	$body = (string) $request->get_body();
	if ( strlen( $body ) > RECITAL_LIVE_MAX_BYTES ) {
		return new WP_Error( 'recital_too_big', __( 'That is too big to send (the limit is 512 KB).', 'recital-live' ), array( 'status' => 413 ) );
	}
	$data = json_decode( $body );
	if ( ! is_object( $data ) ) {
		return new WP_Error( 'recital_bad_json', __( 'The desktop sent something that is not a JSON object.', 'recital-live' ), array( 'status' => 400 ) );
	}
	return $data;
}

/**
 * Saves a JSON document in post meta. Meta writes make no revisions and only clear this post's meta cache.
 *
 * @param int    $post_id Show ID.
 * @param string $key     Meta key.
 * @param object $data    Document.
 */
function recital_live_store( $post_id, $key, $data ) {
	$json = wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	// update_post_meta() unslashes, so slash first or backslashes in the JSON would be lost.
	update_post_meta( $post_id, $key, wp_slash( $json ) );
}

/**
 * POST /shows/{slug}/program.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function recital_live_rest_post_program( $request ) {
	$data = recital_live_read_body( $request );
	if ( is_wp_error( $data ) ) {
		return $data;
	}
	$post_id = (int) $request->get_param( '_rl_post_id' );
	recital_live_store( $post_id, '_rl_program', $data );
	recital_live_write_public( $post_id );
	return recital_live_response(
		array(
			'ok'         => true,
			'server_now' => recital_live_now_ms(),
		)
	);
}

/**
 * POST /shows/{slug}/status. Arrives every 2 seconds during a show, so it only writes two meta values.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function recital_live_rest_post_status( $request ) {
	$data = recital_live_read_body( $request );
	if ( is_wp_error( $data ) ) {
		return $data;
	}
	$post_id = (int) $request->get_param( '_rl_post_id' );
	$now     = recital_live_now_ms();
	// "chat_after" is a note from the desk about the chat, not part of the show's status: don't keep it.
	$after = isset( $data->chat_after ) ? (float) $data->chat_after : 0;
	unset( $data->chat_after );
	recital_live_store( $post_id, '_rl_status', $data );
	update_post_meta( $post_id, '_rl_received_at', (string) $now );
	recital_live_write_public( $post_id );
	// New crew chat messages ride back on the reply the desk is already waiting for.
	return recital_live_response(
		array(
			'ok'         => true,
			'server_now' => recital_live_now_ms(),
			'chat_on'    => recital_live_chat_on( $post_id ),
			'chat'       => recital_live_chat_get( $post_id, $after ),
		)
	);
}

/**
 * True when the viewer may see cues and props: the show has no crew code, or the right one was given.
 * Codes are compared ignoring case and spaces at the ends, since phones like to capitalise.
 *
 * @param int    $post_id Show ID.
 * @param string $given   Code from the viewer.
 * @return bool
 */
function recital_live_is_crew( $post_id, $given ) {
	$code = trim( (string) get_post_meta( $post_id, '_rl_crew_code', true ) );
	if ( '' === $code ) {
		return true;
	}
	$given = trim( (string) $given );
	return '' !== $given && hash_equals( strtolower( $code ), strtolower( $given ) );
}

/**
 * Removes crew-only fields (cues, props, notes) for viewers who aren't crew.
 *
 * @param object|null $program Program.
 * @param object|null $status  Status.
 */
function recital_live_strip_crew( $program, $status ) {
	if ( is_object( $program ) && isset( $program->tracks ) && is_array( $program->tracks ) ) {
		foreach ( $program->tracks as $track ) {
			if ( is_object( $track ) ) {
				unset( $track->cues, $track->props, $track->notes );
			}
		}
	}
	if ( is_object( $status ) ) {
		unset( $status->cue, $status->next_cue, $status->upcoming_cues, $status->props );
	}
}

/**
 * GET /shows/{slug}: everything a phone needs.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function recital_live_rest_get( $request ) {
	$post = recital_live_find_show( $request['slug'] );
	if ( ! $post ) {
		return new WP_Error( 'recital_no_show', __( 'There is no show with that name on this site.', 'recital-live' ), array( 'status' => 404 ) );
	}
	$given = $request->get_header( 'x_recital_code' );
	if ( null === $given || '' === $given ) {
		$given = (string) $request->get_param( 'code' );
	}
	return recital_live_response( recital_live_payload( $post, $given ) + array( 'server_now' => recital_live_now_ms() ) );
}

/**
 * What a viewer gets for a show: everything for crew, without cues, props and notes for everyone else.
 *
 * @param WP_Post $post  The show.
 * @param string  $given Crew code the viewer gave ('' for none).
 * @return array
 */
function recital_live_payload( $post, $given ) {
	$has_code = '' !== trim( (string) get_post_meta( $post->ID, '_rl_crew_code', true ) );
	$crew     = recital_live_is_crew( $post->ID, $given );
	$program  = recital_live_get_json( $post->ID, '_rl_program' );
	$status   = recital_live_get_json( $post->ID, '_rl_status' );
	$received = (int) get_post_meta( $post->ID, '_rl_received_at', true );
	if ( ! $crew ) {
		recital_live_strip_crew( $program, $status );
	}
	$out = array(
		'show'        => array(
			'slug'     => $post->post_name,
			'title'    => $post->post_title,
			'has_code' => $has_code,
		),
		'crew'        => $crew,
		'program'     => $program,
		'status'      => $status,
		'received_at' => $received > 0 ? $received : null,
	);
	// Crew chat: only for viewers who gave the crew code (so never in the public file).
	if ( $has_code && $crew && '' !== trim( (string) $given ) ) {
		$out['chat_on'] = true;
		$out['chat']    = recital_live_chat_get( $post->ID, 0 );
	}
	return $out;
}

/*
 * Crew chat: a short group conversation between crew phones and the desk. It needs a crew code on the show
 * (so the audience can't write to the booth). The last 60 messages are kept with the show.
 */
function recital_live_chat_on( $post_id ) {
	return '' !== trim( (string) get_post_meta( $post_id, '_rl_crew_code', true ) );
}
function recital_live_chat_all( $post_id ) {
	$list = json_decode( (string) get_post_meta( $post_id, '_rl_chat', true ), true );
	return is_array( $list ) ? $list : array();
}
/**
 * Messages newer than $after (an id), at most the last 30.
 *
 * @param int   $post_id Show ID.
 * @param float $after   Only messages with a larger id.
 * @return array
 */
function recital_live_chat_get( $post_id, $after ) {
	$out = array();
	foreach ( recital_live_chat_all( $post_id ) as $m ) {
		if ( isset( $m['id'] ) && (float) $m['id'] > $after ) {
			$out[] = $m;
		}
	}
	return array_slice( $out, -30 );
}
function recital_live_chat_add( $post_id, $from, $role, $text ) {
	$list = recital_live_chat_all( $post_id );
	$last = $list ? (float) $list[ count( $list ) - 1 ]['id'] : 0;
	$msg  = array(
		'id'   => max( $last + 1, recital_live_now_ms() ),
		't'    => recital_live_now_ms(),
		'from' => $from,
		'role' => $role,
		'text' => $text,
	);
	$list[] = $msg;
	recital_live_store( $post_id, '_rl_chat', array_slice( $list, -60 ) );
	return $msg;
}
/**
 * Who may write: the desk (desktop key) or crew (crew code). Nobody else.
 *
 * @param WP_REST_Request $request Request.
 * @return true|WP_Error
 */
function recital_live_rest_check_chat( $request ) {
	$post = recital_live_find_show( $request['slug'], true );
	if ( ! $post ) {
		return new WP_Error( 'recital_no_show', __( 'There is no show with that name on this site.', 'recital-live' ), array( 'status' => 404 ) );
	}
	if ( ! recital_live_chat_on( $post->ID ) ) {
		return new WP_Error( 'recital_chat_off', __( 'Chat needs a crew code on the show. Set one in WordPress under Recital Live.', 'recital-live' ), array( 'status' => 403 ) );
	}
	$key    = (string) $request->get_header( 'x_recital_key' );
	$stored = (string) get_post_meta( $post->ID, '_rl_key', true );
	if ( '' !== $key && '' !== $stored && hash_equals( $stored, $key ) ) {
		$request->set_param( '_rl_chat_role', 'desk' );
	} elseif ( recital_live_is_crew( $post->ID, (string) $request->get_header( 'x_recital_code' ) ) ) {
		$request->set_param( '_rl_chat_role', 'crew' );
	} else {
		return new WP_Error( 'recital_bad_code', __( 'The crew code is not right.', 'recital-live' ), array( 'status' => 403 ) );
	}
	$request->set_param( '_rl_post_id', $post->ID );
	return true;
}
/**
 * POST /shows/{slug}/chat  { name, text }  (the desk may send { clear: true }).
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function recital_live_rest_post_chat( $request ) {
	$data = recital_live_read_body( $request );
	if ( is_wp_error( $data ) ) {
		return $data;
	}
	$post_id = (int) $request->get_param( '_rl_post_id' );
	$role    = (string) $request->get_param( '_rl_chat_role' );
	if ( 'desk' === $role && ! empty( $data->clear ) ) {
		recital_live_store( $post_id, '_rl_chat', array() );
		return recital_live_response( array( 'ok' => true, 'chat' => array() ) );
	}
	$text = isset( $data->text ) && is_string( $data->text ) ? trim( sanitize_text_field( $data->text ) ) : '';
	if ( '' === $text ) {
		return new WP_Error( 'recital_empty', __( 'Type a message first.', 'recital-live' ), array( 'status' => 400 ) );
	}
	$text = function_exists( 'mb_substr' ) ? mb_substr( $text, 0, 280 ) : substr( $text, 0, 280 );
	if ( 'desk' === $role ) {
		$from = __( 'Booth', 'recital-live' );
	} else {
		$name = isset( $data->name ) && is_string( $data->name ) ? trim( sanitize_text_field( $data->name ) ) : '';
		$from = '' !== $name ? ( function_exists( 'mb_substr' ) ? mb_substr( $name, 0, 30 ) : substr( $name, 0, 30 ) ) : __( 'Crew', 'recital-live' );
		// One message every 1.5 s per phone, so a stuck button can't flood the booth.
		$who = 'rl_chat_' . md5( $post_id . '|' . ( isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '' ) . '|' . $from );
		$last = (float) get_transient( $who );
		if ( $last && recital_live_now_ms() - $last < 1500 ) {
			return new WP_Error( 'recital_slow_down', __( 'That was quick. Wait a moment and send again.', 'recital-live' ), array( 'status' => 429 ) );
		}
		set_transient( $who, (string) recital_live_now_ms(), 60 );
	}
	$msg = recital_live_chat_add( $post_id, $from, $role, $text );
	return recital_live_response(
		array(
			'ok'      => true,
			'message' => $msg,
			'chat'    => recital_live_chat_get( $post_id, 0 ),
		)
	);
}

/**
 * Where the public copy of a show lives: a small file the web server hands out by itself, so hundreds of
 * phones don't each start WordPress every couple of seconds.
 *
 * @param string $slug Show slug.
 * @return array|null { path, url } or null when uploads aren't available.
 */
function recital_live_public_file( $slug ) {
	$up = wp_upload_dir( null, false );
	if ( ! is_array( $up ) || ! empty( $up['error'] ) || empty( $up['basedir'] ) ) {
		return null;
	}
	$name = sanitize_file_name( $slug ) . '.json';
	return array(
		'dir'  => $up['basedir'] . '/recital-live',
		'path' => $up['basedir'] . '/recital-live/' . $name,
		'url'  => $up['baseurl'] . '/recital-live/' . $name,
	);
}

/**
 * Writes (or removes) the public copy. It holds exactly what a visitor without the crew code is allowed to see.
 * Failure is harmless: phones fall back to asking WordPress.
 *
 * @param int $post_id Show ID.
 */
function recital_live_write_public( $post_id ) {
	$post = get_post( $post_id );
	if ( ! $post || 'recital_show' !== $post->post_type ) {
		return;
	}
	$file = recital_live_public_file( $post->post_name );
	if ( ! $file ) {
		return;
	}
	if ( 'publish' !== $post->post_status ) {
		if ( file_exists( $file['path'] ) ) {
			@unlink( $file['path'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
		return;
	}
	if ( ! is_dir( $file['dir'] ) && ! wp_mkdir_p( $file['dir'] ) ) {
		return;
	}
	$json = wp_json_encode( recital_live_payload( $post, '' ) );
	$tmp  = $file['path'] . '.' . wp_generate_password( 8, false ) . '.tmp';
	// Written to a temporary file and renamed, so a phone never reads half a file.
	if ( false !== @file_put_contents( $tmp, $json ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		if ( ! @rename( $tmp, $file['path'] ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.rename_rename
			@unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
	}
}
// Keep the public copy right when the show is edited (crew code, title, published or not), and remove it with the show.
add_action( 'save_post_recital_show', 'recital_live_write_public', 99 );
add_action(
	'before_delete_post',
	function ( $post_id ) {
		$post = get_post( $post_id );
		if ( $post && 'recital_show' === $post->post_type ) {
			$file = recital_live_public_file( $post->post_name );
			if ( $file && file_exists( $file['path'] ) ) {
				@unlink( $file['path'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			}
		}
	}
);
