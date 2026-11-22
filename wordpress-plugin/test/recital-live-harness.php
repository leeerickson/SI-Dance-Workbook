<?php
/*
 * A tiny stand-in for WordPress, just enough to run the Recital Live plugin under PHP's built-in server:
 *
 *   RL_DB=/tmp/rl-db.json php -S 127.0.0.1:8099 wordpress-plugin/test/recital-live-harness.php
 *
 * It stores shows, options and post meta in the JSON file named by RL_DB, uses the plugin's own rewrite rules
 * to route /recital/... addresses, and dispatches /wp-json/... (or ?rest_route=) to the plugin's REST routes.
 * Extra test-only pages: /__shortcode?show=slug and /__admin?id=1 (the Edit show settings box).
 * The real WordPress test runs on GitHub (see .github/workflows/recital-live-plugin.yml).
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'RL_PLUGIN_DIR', dirname( __DIR__ ) . '/recital-live' );

$rl_uri  = (string) $_SERVER['REQUEST_URI'];
$rl_path = (string) parse_url( $rl_uri, PHP_URL_PATH );
$rl_host = 'http://' . $_SERVER['HTTP_HOST'];

// The uploads folder (the public copy of each show) is served as plain files, as a web server would.
define( 'RL_UPLOADS', dirname( getenv( 'RL_DB' ) ?: sys_get_temp_dir() . '/recital-live-db.json' ) . '/uploads' );
if ( 0 === strpos( $rl_path, '/wp-content/uploads/' ) ) {
	$file = realpath( RL_UPLOADS . '/' . substr( $rl_path, strlen( '/wp-content/uploads/' ) ) );
	if ( ! $file || 0 !== strpos( $file, realpath( RL_UPLOADS ) . '/' ) || ! is_file( $file ) ) {
		http_response_code( 404 );
		return true;
	}
	header( 'Content-Type: application/json' );
	header( 'X-Served: static' );
	readfile( $file );
	return true;
}

// Plugin files (styles, script, icons) are served as they are.
if ( 0 === strpos( $rl_path, '/wp-content/plugins/recital-live/' ) ) {
	$file = realpath( RL_PLUGIN_DIR . '/' . substr( $rl_path, strlen( '/wp-content/plugins/recital-live/' ) ) );
	if ( ! $file || 0 !== strpos( $file, realpath( RL_PLUGIN_DIR ) . '/assets/' ) || ! is_file( $file ) ) {
		http_response_code( 404 );
		return true;
	}
	$types = array( 'css' => 'text/css', 'js' => 'text/javascript', 'png' => 'image/png', 'svg' => 'image/svg+xml' );
	header( 'Content-Type: ' . ( $types[ pathinfo( $file, PATHINFO_EXTENSION ) ] ?? 'application/octet-stream' ) );
	readfile( $file );
	return true;
}

/* ---------- storage ---------- */

function rl_db_path() {
	return getenv( 'RL_DB' ) ?: sys_get_temp_dir() . '/recital-live-db.json';
}
function rl_db_load() {
	$f = fopen( rl_db_path(), 'c+' );
	flock( $f, LOCK_SH );
	$raw = stream_get_contents( $f );
	flock( $f, LOCK_UN );
	fclose( $f );
	$db = json_decode( (string) $raw, true );
	return is_array( $db ) ? $db + array( 'options' => array(), 'posts' => array(), 'meta' => array() ) : array( 'options' => array(), 'posts' => array(), 'meta' => array() );
}
function rl_db_change( $fn ) {
	$f = fopen( rl_db_path(), 'c+' );
	flock( $f, LOCK_EX );
	$db = json_decode( (string) stream_get_contents( $f ), true );
	if ( ! is_array( $db ) ) {
		$db = array();
	}
	$db += array( 'options' => array(), 'posts' => array(), 'meta' => array() );
	$db = $fn( $db );
	ftruncate( $f, 0 );
	rewind( $f );
	fwrite( $f, json_encode( $db, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT ) );
	fflush( $f );
	flock( $f, LOCK_UN );
	fclose( $f );
	$GLOBALS['rl_db'] = $db;
}
$GLOBALS['rl_db'] = rl_db_load();

/* ---------- WordPress stand-ins ---------- */

class WP_Post {
	public $ID, $post_name = '', $post_title = '', $post_status = 'publish', $post_type = 'post';
	public function __construct( $a ) {
		foreach ( $a as $k => $v ) {
			$this->$k = $v;
		}
	}
}
class WP_Error {
	public $code, $message, $data;
	public function __construct( $code = '', $message = '', $data = null ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
}
class WP_REST_Response {
	public $data, $status, $headers = array();
	public function __construct( $data = null, $status = 200 ) {
		$this->data   = $data;
		$this->status = $status;
	}
	public function header( $k, $v ) {
		$this->headers[ $k ] = $v;
	}
}
class WP_REST_Request implements ArrayAccess {
	private $params = array(), $headers = array(), $body = '', $method;
	public function __construct( $method, $params, $headers, $body ) {
		$this->method = $method;
		$this->params = $params;
		foreach ( $headers as $k => $v ) {
			$this->headers[ strtolower( str_replace( '-', '_', $k ) ) ] = $v;
		}
		$this->body = $body;
	}
	public function get_header( $k ) {
		$k = strtolower( str_replace( '-', '_', $k ) );
		return $this->headers[ $k ] ?? null;
	}
	public function get_body() { return $this->body; }
	public function get_method() { return $this->method; }
	public function get_param( $k ) { return $this->params[ $k ] ?? null; }
	public function set_param( $k, $v ) { $this->params[ $k ] = $v; }
	public function offsetExists( $k ): bool { return isset( $this->params[ $k ] ); }
	#[\ReturnTypeWillChange]
	public function offsetGet( $k ) { return $this->params[ $k ] ?? null; }
	public function offsetSet( $k, $v ): void { $this->params[ $k ] = $v; }
	public function offsetUnset( $k ): void { unset( $this->params[ $k ] ); }
}

$GLOBALS['rl_hooks']      = array();
$GLOBALS['rl_rules']      = array();
$GLOBALS['rl_routes']     = array();
$GLOBALS['rl_shortcodes'] = array();
function add_action( $h, $f, $p = 10, $n = 1 ) { $GLOBALS['rl_hooks'][ $h ][] = array( $f, $n ); return true; }
function add_filter( $h, $f, $p = 10, $n = 1 ) { return add_action( $h, $f, $p, $n ); }
function do_action( $h, ...$args ) {
	foreach ( $GLOBALS['rl_hooks'][ $h ] ?? array() as $cb ) {
		call_user_func_array( $cb[0], array_slice( $args, 0, $cb[1] ) );
	}
}
function apply_filters( $h, $value, ...$args ) {
	foreach ( $GLOBALS['rl_hooks'][ $h ] ?? array() as $cb ) {
		$value = call_user_func_array( $cb[0], array_slice( array_merge( array( $value ), $args ), 0, $cb[1] ) );
	}
	return $value;
}
function register_activation_hook( $f, $cb ) {}
function register_deactivation_hook( $f, $cb ) {}
function is_admin() { return false; }
function register_post_type( $t, $a ) { $GLOBALS['rl_post_types'][ $t ] = $a; }
function add_rewrite_rule( $regex, $query, $after = 'bottom' ) { $GLOBALS['rl_rules'][ $regex ] = $query; }
function flush_rewrite_rules( $hard = true ) { $GLOBALS['rl_flushed'] = true; }
function get_option( $k, $d = false ) {
	if ( 'permalink_structure' === $k ) {
		return getenv( 'RL_PLAIN' ) ? '' : '/%postname%/';
	}
	return $GLOBALS['rl_db']['options'][ $k ] ?? $d;
}
function update_option( $k, $v ) { rl_db_change( function ( $db ) use ( $k, $v ) { $db['options'][ $k ] = $v; return $db; } ); return true; }
function delete_option( $k ) { rl_db_change( function ( $db ) use ( $k ) { unset( $db['options'][ $k ] ); return $db; } ); return true; }
function __( $t, $d = '' ) { return $t; }
function _n( $s, $p, $n, $d = '' ) { return 1 === (int) $n ? $s : $p; }
function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function esc_attr( $t ) { return esc_html( $t ); }
function esc_textarea( $t ) { return esc_html( $t ); }
function esc_html__( $t, $d = '' ) { return esc_html( $t ); }
function esc_html_e( $t, $d = '' ) { echo esc_html( $t ); }
function esc_attr_e( $t, $d = '' ) { echo esc_attr( $t ); }
function esc_url( $u ) { return esc_html( filter_var( (string) $u, FILTER_SANITIZE_URL ) ); }
function sanitize_title( $t ) { return trim( preg_replace( '/[^a-z0-9_-]+/', '-', strtolower( strip_tags( (string) $t ) ) ), '-' ); }
function sanitize_text_field( $t ) { return trim( strip_tags( (string) $t ) ); }
function wp_strip_all_tags( $t ) { return trim( strip_tags( (string) $t ) ); }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function untrailingslashit( $s ) { return rtrim( $s, '/\\' ); }
function wp_slash( $v ) { return is_string( $v ) ? addslashes( $v ) : $v; }
function wp_unslash( $v ) { return is_string( $v ) ? stripslashes( $v ) : $v; }
function wp_upload_dir( $t = null, $c = true ) { global $rl_host; return array( 'basedir' => RL_UPLOADS, 'baseurl' => $rl_host . '/wp-content/uploads', 'error' => false ); }
function wp_mkdir_p( $d ) { return is_dir( $d ) || mkdir( $d, 0777, true ); }
function sanitize_file_name( $n ) { return preg_replace( '/[^A-Za-z0-9._-]/', '', (string) $n ); }
function get_transient( $k ) { $db = rl_db_load(); return $db['options'][ '_t_' . $k ] ?? false; }
function set_transient( $k, $v, $ttl = 0 ) { rl_db_change( function ( $db ) use ( $k, $v ) { $db['options'][ '_t_' . $k ] = $v; return $db; } ); return true; }
function wp_json_encode( $d, $o = 0, $depth = 512 ) { return json_encode( $d, $o, $depth ); }
function wp_generate_password( $len = 12, $special = true ) {
	$chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	$out   = '';
	for ( $i = 0; $i < $len; $i++ ) {
		$out .= $chars[ random_int( 0, strlen( $chars ) - 1 ) ];
	}
	return $out;
}
function home_url( $path = '' ) { return $GLOBALS['rl_host'] . ( $path ? '/' . ltrim( $path, '/' ) : '' ); }
function rest_url( $path = '' ) {
	return getenv( 'RL_PLAIN' ) ? home_url( '/?rest_route=/' . ltrim( $path, '/' ) ) : home_url( '/wp-json/' . ltrim( $path, '/' ) );
}
function plugins_url( $path, $file ) { return home_url( '/wp-content/plugins/recital-live/' . ltrim( $path, '/' ) ); }
function add_query_arg( $k, $v, $url ) { return $url . ( false === strpos( $url, '?' ) ? '?' : '&' ) . rawurlencode( $k ) . '=' . rawurlencode( $v ); }
function status_header( $code ) { http_response_code( $code ); }
function nocache_headers() { header( 'Cache-Control: no-cache, must-revalidate, max-age=0' ); }
function get_bloginfo( $k ) { return 'Studio test site'; }
function current_user_can( $c, ...$a ) { return true; }
function is_wp_error( $v ) { return $v instanceof WP_Error; }
function __return_true() { return true; }
function shortcode_atts( $pairs, $atts, $sc = '' ) { $atts = (array) $atts; $out = array(); foreach ( $pairs as $k => $v ) { $out[ $k ] = array_key_exists( $k, $atts ) ? $atts[ $k ] : $v; } return $out; }
function add_shortcode( $tag, $f ) { $GLOBALS['rl_shortcodes'][ $tag ] = $f; }
function register_rest_route( $ns, $route, $args ) { $GLOBALS['rl_routes'][ '/' . $ns . $route ] = $args; }
function get_post( $id ) {
	foreach ( $GLOBALS['rl_db']['posts'] as $p ) {
		if ( (int) $p['ID'] === (int) $id ) {
			return new WP_Post( $p );
		}
	}
	return null;
}
function get_posts( $q ) {
	$statuses = (array) ( $q['post_status'] ?? 'publish' );
	$out      = array();
	foreach ( $GLOBALS['rl_db']['posts'] as $p ) {
		if ( ( $p['post_type'] ?? '' ) !== $q['post_type'] || ! in_array( $p['post_status'], $statuses, true ) ) {
			continue;
		}
		if ( isset( $q['name'] ) && $p['post_name'] !== $q['name'] ) {
			continue;
		}
		$out[] = new WP_Post( $p );
	}
	if ( ( $q['orderby'] ?? '' ) === 'title' ) {
		usort( $out, function ( $a, $b ) { return strcmp( $a->post_title, $b->post_title ); } );
	}
	$n = (int) ( $q['posts_per_page'] ?? 10 );
	return $n > 0 ? array_slice( $out, 0, $n ) : $out;
}
function get_post_meta( $id, $key, $single = false ) {
	return $GLOBALS['rl_db']['meta'][ (string) $id ][ $key ] ?? '';
}
function update_post_meta( $id, $key, $value ) {
	$value = wp_unslash( $value ); // Like WordPress: meta values are unslashed before saving.
	rl_db_change( function ( $db ) use ( $id, $key, $value ) { $db['meta'][ (string) $id ][ $key ] = $value; return $db; } );
	return true;
}
// Admin-only stand-ins for the settings box.
function wp_nonce_field( $a, $n ) { echo '<input type="hidden" name="' . esc_attr( $n ) . '" value="test">'; }
function checked( $a, $b = true, $echo = true ) { $r = ( (string) $a === (string) $b ) ? ' checked="checked"' : ''; if ( $echo ) { echo $r; } return $r; }

/* ---------- load the plugin ---------- */

require RL_PLUGIN_DIR . '/recital-live.php';
do_action( 'init' );

function rl_send_json( $status, $data, $headers = array() ) {
	http_response_code( $status );
	header( 'Content-Type: application/json; charset=UTF-8' );
	foreach ( $headers as $k => $v ) {
		header( $k . ': ' . $v );
	}
	echo json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
}
function rl_error_json( WP_Error $e ) {
	$status = is_array( $e->data ) && isset( $e->data['status'] ) ? (int) $e->data['status'] : 500;
	rl_send_json( $status, array( 'code' => $e->code, 'message' => $e->message, 'data' => $e->data ) );
}

/* ---------- REST API ---------- */

$rl_route = null;
if ( 0 === strpos( $rl_path, '/wp-json/' ) ) {
	$rl_route = '/' . trim( substr( $rl_path, strlen( '/wp-json' ) ), '/' );
} elseif ( isset( $_GET['rest_route'] ) ) {
	$rl_route = '/' . trim( (string) $_GET['rest_route'], '/' );
}
if ( null !== $rl_route ) {
	do_action( 'rest_api_init' );
	$method = $_SERVER['REQUEST_METHOD'];
	if ( 'OPTIONS' === $method ) {
		http_response_code( 200 );
		return true;
	}
	foreach ( $GLOBALS['rl_routes'] as $pattern => $args ) {
		if ( ! preg_match( '@^' . $pattern . '$@i', $rl_route, $m ) ) {
			continue;
		}
		if ( strtoupper( $args['methods'] ) !== $method ) {
			continue;
		}
		$params = $_GET;
		unset( $params['rest_route'] );
		foreach ( $m as $k => $v ) {
			if ( is_string( $k ) ) {
				$params[ $k ] = urldecode( $v );
			}
		}
		$headers = function_exists( 'getallheaders' ) ? getallheaders() : array();
		$req     = new WP_REST_Request( $method, $params, $headers, (string) file_get_contents( 'php://input' ) );
		$ok      = call_user_func( $args['permission_callback'], $req );
		if ( $ok instanceof WP_Error ) {
			rl_error_json( $ok );
			return true;
		}
		if ( true !== $ok ) {
			rl_send_json( 401, array( 'code' => 'rest_forbidden' ) );
			return true;
		}
		$res = call_user_func( $args['callback'], $req );
		if ( $res instanceof WP_Error ) {
			rl_error_json( $res );
		} else {
			rl_send_json( $res->status, $res->data, $res->headers );
		}
		return true;
	}
	rl_send_json( 404, array( 'code' => 'rest_no_route' ) );
	return true;
}

/* ---------- test-only pages ---------- */

if ( '/__shortcode' === $rl_path ) {
	echo '<!doctype html><html><head><meta charset="utf-8"><title>Shortcode test</title></head><body><h1>Our recital</h1>';
	echo call_user_func( $GLOBALS['rl_shortcodes']['recital_live'], array( 'show' => $_GET['show'] ?? '', 'height' => '700' ) );
	echo '</body></html>';
	return true;
}
if ( '/__admin' === $rl_path ) {
	require RL_PLUGIN_DIR . '/includes/admin.php';
	echo '<!doctype html><html><head><meta charset="utf-8"><title>Admin box test</title></head><body>';
	recital_live_meta_box( get_post( (int) ( $_GET['id'] ?? 0 ) ) );
	echo '</body></html>';
	return true;
}

/* ---------- /recital/ pages, using the plugin's own rewrite rules ---------- */

$rl_vars    = array();
$rl_allowed = apply_filters( 'query_vars', array() );
foreach ( $_GET as $k => $v ) {
	if ( in_array( $k, $rl_allowed, true ) ) {
		$rl_vars[ $k ] = (string) $v;
	}
}
$rl_req = ltrim( $rl_path, '/' );
if ( '' !== $rl_req ) {
	foreach ( $GLOBALS['rl_rules'] as $regex => $query ) {
		if ( preg_match( '#' . $regex . '#', $rl_req, $m ) ) {
			parse_str( (string) parse_url( preg_replace_callback( '/\$matches\[(\d+)\]/', function ( $x ) use ( $m ) { return rawurlencode( $m[ (int) $x[1] ] ); }, $query ), PHP_URL_QUERY ), $q );
			foreach ( $q as $k => $v ) {
				if ( in_array( $k, $rl_allowed, true ) ) {
					$rl_vars[ $k ] = $v;
				}
			}
			break;
		}
	}
}
$GLOBALS['rl_wp'] = (object) array( 'query_vars' => $rl_vars );
do_action( 'parse_request', $GLOBALS['rl_wp'] );

// Nothing from the plugin handled it: this is where the theme would take over.
http_response_code( 404 );
echo 'Not a Recital Live address.';
return true;
