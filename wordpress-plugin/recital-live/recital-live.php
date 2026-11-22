<?php
/**
 * Plugin Name:       Recital Live
 * Description:       Follow a recital live on your phone. The Recital Show Player desktop app sends what's playing to your site, and parents, teachers, techs and prop crew open a small web page to see the current dance, what's next, timers, cues and props.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Choreography Workbook
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       recital-live
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'RECITAL_LIVE_VERSION', '0.1.0' );
define( 'RECITAL_LIVE_FILE', __FILE__ );
define( 'RECITAL_LIVE_DIR', __DIR__ );
define( 'RECITAL_LIVE_MAX_BYTES', 512 * 1024 );
// Bump when the rewrite rules change, so they are flushed once on the next page load.
define( 'RECITAL_LIVE_RULES', '1' );

require_once __DIR__ . '/includes/common.php';
require_once __DIR__ . '/includes/rest.php';
require_once __DIR__ . '/includes/front.php';
if ( is_admin() ) {
	require_once __DIR__ . '/includes/admin.php';
}

add_action( 'init', 'recital_live_register' );

register_activation_hook(
	__FILE__,
	function () {
		recital_live_register();
		flush_rewrite_rules();
		update_option( 'recital_live_rules', RECITAL_LIVE_RULES );
	}
);

register_deactivation_hook(
	__FILE__,
	function () {
		// Our rules are still registered during this request, so drop the saved rules and let
		// WordPress rebuild them without this plugin on the next page load.
		delete_option( 'rewrite_rules' );
		delete_option( 'recital_live_rules' );
	}
);
