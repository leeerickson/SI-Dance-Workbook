<?php
/*
 * Renders a test page with the plugin's shortcode, using small stand-ins for the WordPress
 * functions it calls. Usage: php render-page.php '<shortcode attributes as JSON>' > page.html
 * The real WordPress test runs on GitHub (see .github/workflows/wordpress-plugin.yml).
 */
define( 'ABSPATH', __DIR__ );
$GLOBALS['dp_hooks'] = array();
$GLOBALS['dp_scripts'] = array();
function add_filter( $h, $f, $p = 10, $n = 1 ) { $GLOBALS['dp_hooks'][ $h ][] = $f; }
function add_action( $h, $f, $p = 10, $n = 1 ) { $GLOBALS['dp_hooks'][ $h ][] = $f; }
function add_shortcode( $tag, $f ) { $GLOBALS['dp_hooks'][ 'shortcode_' . $tag ] = $f; }
function shortcode_atts( $pairs, $atts, $sc = '' ) { $atts = (array) $atts; $out = array(); foreach ( $pairs as $k => $v ) { $out[ $k ] = array_key_exists( $k, $atts ) ? $atts[ $k ] : $v; } return $out; }
function __( $t, $d = '' ) { return $t; }
function wp_get_attachment_url( $id ) { return 123 === $id ? '/uploads/spotlight.dance' : false; }
function esc_url_raw( $u, $p = null ) { return filter_var( $u, FILTER_SANITIZE_URL ); }
function esc_url( $u ) { return htmlspecialchars( $u, ENT_QUOTES ); }
function esc_attr( $t ) { return htmlspecialchars( $t, ENT_QUOTES ); }
function plugins_url( $path, $file ) { return '/wp-content/plugins/dance-player/' . $path; }
function add_query_arg( $args, $url ) { if ( ! $args ) { return $url; } $q = array(); foreach ( $args as $k => $v ) { $q[] = $k . '=' . $v; } return $url . ( strpos( $url, '?' ) === false ? '?' : '&' ) . implode( '&', $q ); }
function wp_enqueue_script( $h, $src ) { $GLOBALS['dp_scripts'][ $h ] = $src; }

require dirname( __DIR__ ) . '/dance-player/dance-player.php';

// The upload filter must allow .dance files.
$mimes = $GLOBALS['dp_hooks']['upload_mimes'][0]( array() );
$check = $GLOBALS['dp_hooks']['wp_check_filetype_and_ext'][0]( array( 'ext' => false, 'type' => false, 'proper_filename' => false ), '/tmp/x', 'spotlight.dance' );
fwrite( STDERR, 'upload_mimes dance=' . $mimes['dance'] . ' check=' . $check['ext'] . '/' . $check['type'] . "\n" );

$players = array();
foreach ( json_decode( $argv[1], true ) as $atts ) {
	$players[] = $GLOBALS['dp_hooks']['shortcode_dance_player']( $atts );
}
$script = isset( $GLOBALS['dp_scripts']['dance-player-embed'] ) ? '<script src="' . $GLOBALS['dp_scripts']['dance-player-embed'] . '"></script>' : '';
echo "<!doctype html><html><head><meta charset=\"utf-8\"><title>Dance Player test page</title></head><body style=\"font-family:sans-serif;max-width:760px;margin:0 auto;padding:20px\"><h1>Recital numbers</h1>\n" . implode( "\n<p>Text between players.</p>\n", $players ) . "\n" . $script . "</body></html>\n";
