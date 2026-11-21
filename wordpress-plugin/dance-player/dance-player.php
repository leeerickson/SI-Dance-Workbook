<?php
/**
 * Plugin Name:       Dance Player
 * Description:       Show a Choreography Workbook .dance file on any page: the counts, notes, formations, props and music play together, just like the Workbook Player app. Add the Dance Player block, or the [dance_player] shortcode.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Choreography Workbook
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       dance-player
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'DANCE_PLAYER_VERSION', '0.1.0' );

/*
 * .dance files are zip files. Let people who can upload media add them to the Media Library.
 */
add_filter(
	'upload_mimes',
	function ( $mimes ) {
		$mimes['dance'] = 'application/zip';
		return $mimes;
	}
);
add_filter(
	'wp_check_filetype_and_ext',
	function ( $data, $file, $filename ) {
		if ( 'dance' === strtolower( pathinfo( $filename, PATHINFO_EXTENSION ) ) ) {
			$data['ext']             = 'dance';
			$data['type']            = 'application/zip';
			$data['proper_filename'] = $filename;
		}
		return $data;
	},
	10,
	3
);

/**
 * Builds the player for a page. The player runs in an iframe so the theme's styles can't change it.
 *
 * @param array $atts file (URL or Media Library ID), open (yes/no), width, height, title.
 * @return string HTML.
 */
function dance_player_render( $atts ) {
	$a = shortcode_atts(
		array(
			'file'   => '',
			'open'   => 'yes',
			'width'  => '480',
			'height' => '900',
			'title'  => __( 'Dance player', 'dance-player' ),
		),
		$atts,
		'dance_player'
	);

	$file = trim( (string) $a['file'] );
	if ( '' !== $file && ctype_digit( $file ) ) {
		$file = (string) wp_get_attachment_url( (int) $file );
	}
	$file = $file ? esc_url_raw( $file, array( 'http', 'https' ) ) : '';

	$args = array();
	if ( $file ) {
		$args['file'] = rawurlencode( $file );
	}
	if ( in_array( strtolower( (string) $a['open'] ), array( 'no', 'false', '0' ), true ) ) {
		$args['open'] = '0';
	}
	$src = add_query_arg( $args, plugins_url( 'player/index.html', __FILE__ ) );

	wp_enqueue_script( 'dance-player-embed', plugins_url( 'assets/embed.js', __FILE__ ), array(), DANCE_PLAYER_VERSION, true );

	$width  = max( 320, min( 1200, (int) $a['width'] ) );
	$height = max( 400, (int) $a['height'] );

	return sprintf(
		'<div class="dance-player-wrap" style="max-width:%1$dpx;margin:1.5em auto"><iframe class="dance-player-frame" src="%2$s" title="%3$s" style="width:100%%;height:%4$dpx;border:0;border-radius:16px;display:block;background:#EDF0F5" allow="autoplay; fullscreen; screen-wake-lock"></iframe></div>',
		$width,
		esc_url( $src ),
		esc_attr( $a['title'] ),
		$height
	);
}
add_shortcode( 'dance_player', 'dance_player_render' );

/*
 * Dance Player block for the block editor. It uses the same output as the shortcode.
 */
add_action(
	'init',
	function () {
		if ( ! function_exists( 'register_block_type' ) ) {
			return;
		}
		wp_register_script(
			'dance-player-block',
			plugins_url( 'assets/block.js', __FILE__ ),
			array( 'wp-blocks', 'wp-element', 'wp-components', 'wp-block-editor', 'wp-i18n' ),
			DANCE_PLAYER_VERSION,
			true
		);
		register_block_type(
			'dance-player/player',
			array(
				'api_version'     => 2,
				'editor_script'   => 'dance-player-block',
				'attributes'      => array(
					'fileId'  => array( 'type' => 'number' ),
					'fileUrl' => array( 'type' => 'string', 'default' => '' ),
					'name'    => array( 'type' => 'string', 'default' => '' ),
					'open'    => array( 'type' => 'boolean', 'default' => true ),
					'width'   => array( 'type' => 'number', 'default' => 480 ),
				),
				'render_callback' => function ( $attr ) {
					return dance_player_render(
						array(
							'file'  => ! empty( $attr['fileId'] ) ? (string) $attr['fileId'] : ( isset( $attr['fileUrl'] ) ? $attr['fileUrl'] : '' ),
							'open'  => ! empty( $attr['open'] ) ? 'yes' : 'no',
							'width' => isset( $attr['width'] ) ? (string) $attr['width'] : '480',
						)
					);
				},
			)
		);
	}
);
