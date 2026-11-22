<?php
/**
 * Recital Live: the show settings box and the shows list in the dashboard.
 *
 * @package RecitalLive
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'add_meta_boxes_recital_show',
	function () {
		add_meta_box( 'recital_live_show', __( 'Live show settings', 'recital-live' ), 'recital_live_meta_box', 'recital_show', 'normal', 'high' );
	}
);

add_action(
	'admin_enqueue_scripts',
	function ( $hook ) {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || 'recital_show' !== $screen->post_type ) {
			return;
		}
		wp_enqueue_script( 'recital-live-admin', plugins_url( 'assets/admin.js', RECITAL_LIVE_FILE ), array(), RECITAL_LIVE_VERSION, true );
		wp_localize_script(
			'recital-live-admin',
			'recitalLiveAdmin',
			array(
				'copied'     => __( 'Copied', 'recital-live' ),
				'confirmKey' => __( 'Make a new desktop key? The desktop app will stop updating this show until you paste the new connection code into it.', 'recital-live' ),
			)
		);
	}
);

/**
 * The settings box on the Edit show screen.
 *
 * @param WP_Post $post Show.
 */
function recital_live_meta_box( $post ) {
	wp_nonce_field( 'recital_live_save', 'recital_live_nonce' );
	$slug   = $post->post_name;
	$code   = (string) get_post_meta( $post->ID, '_rl_crew_code', true );
	$listed = recital_live_listed( $post->ID );
	$key    = (string) get_post_meta( $post->ID, '_rl_key', true );
	?>
	<style>
		.rl-box th { width: 180px; }
		.rl-box input.rl-wide, .rl-box textarea { width: 100%; max-width: 640px; }
		.rl-box .rl-code { font-family: monospace; font-size: 12px; }
		.rl-box .rl-row { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
	</style>
	<table class="form-table rl-box" role="presentation">
		<tr>
			<th scope="row"><label for="rl_slug"><?php esc_html_e( 'Short name for the link', 'recital-live' ); ?></label></th>
			<td>
				<input type="text" id="rl_slug" name="rl_slug" class="regular-text" value="<?php echo esc_attr( $slug ); ?>" placeholder="spring-2027">
				<p class="description"><?php esc_html_e( 'Lowercase letters, numbers and dashes. Leave it empty to make one from the title.', 'recital-live' ); ?></p>
			</td>
		</tr>
		<?php if ( '' !== $slug && 'auto-draft' !== $post->post_status ) : ?>
			<tr>
				<th scope="row"><?php esc_html_e( 'Link for phones', 'recital-live' ); ?></th>
				<td>
					<a href="<?php echo esc_url( recital_live_url( 'page', $slug ) ); ?>" target="_blank" rel="noopener"><?php echo esc_html( recital_live_url( 'page', $slug ) ); ?></a>
					<p class="description">
						<?php
						if ( 'publish' === $post->post_status ) {
							esc_html_e( 'Share this with parents, teachers and crew. It works on any phone, and they can add it to their Home Screen.', 'recital-live' );
						} else {
							esc_html_e( 'Publish the show to make this link work.', 'recital-live' );
						}
						?>
					</p>
				</td>
			</tr>
		<?php endif; ?>
		<tr>
			<th scope="row"><label for="rl_crew_code"><?php esc_html_e( 'Crew code (optional)', 'recital-live' ); ?></label></th>
			<td>
				<input type="text" id="rl_crew_code" name="rl_crew_code" class="regular-text" value="<?php echo esc_attr( $code ); ?>" autocomplete="off">
				<p class="description"><?php esc_html_e( 'Techs, teachers and prop crew type this on the phone page to see cues and props. Leave it empty and everyone sees them.', 'recital-live' ); ?></p>
			</td>
		</tr>
		<tr>
			<th scope="row"><?php esc_html_e( 'Listed', 'recital-live' ); ?></th>
			<td>
				<label><input type="checkbox" name="rl_listed" value="1" <?php checked( $listed ); ?>> <?php esc_html_e( 'Show it in the "Other shows" menu on the phone page', 'recital-live' ); ?></label>
			</td>
		</tr>
		<tr>
			<th scope="row"><label for="rl_connection"><?php esc_html_e( 'Connection code', 'recital-live' ); ?></label></th>
			<td>
				<?php if ( '' !== $key && '' !== $slug ) : ?>
					<div class="rl-row">
						<textarea id="rl_connection" class="rl-code" rows="3" readonly onclick="this.select()"><?php echo esc_textarea( recital_live_connection_code( $post ) ); ?></textarea>
						<button type="button" class="button" data-rl-copy="rl_connection"><?php esc_html_e( 'Copy', 'recital-live' ); ?></button>
					</div>
					<p class="description"><?php esc_html_e( 'Paste this into the Recital Show Player desktop app (Settings → Recital Live) so it can send the show to this site. Keep it private: anyone with it can change what phones see.', 'recital-live' ); ?></p>
					<p><button type="submit" name="rl_new_key" value="1" class="button" data-rl-confirm="1"><?php esc_html_e( 'Make a new key', 'recital-live' ); ?></button></p>
				<?php else : ?>
					<p><?php esc_html_e( 'Save the show to get its connection code.', 'recital-live' ); ?></p>
				<?php endif; ?>
			</td>
		</tr>
		<tr>
			<th scope="row"><?php esc_html_e( 'Last update from the desk', 'recital-live' ); ?></th>
			<td><?php echo esc_html( recital_live_last_update_text( $post->ID ) ); ?></td>
		</tr>
	</table>
	<?php
}

/*
 * Use the "Short name for the link" as the post slug (made unique), or one from the title.
 */
add_filter(
	'wp_insert_post_data',
	function ( $data, $postarr ) {
		if ( 'recital_show' !== $data['post_type'] || ! isset( $_POST['recital_live_nonce'] ) ) {
			return $data;
		}
		if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['recital_live_nonce'] ) ), 'recital_live_save' ) ) {
			return $data;
		}
		$wanted = isset( $_POST['rl_slug'] ) ? sanitize_title( wp_unslash( $_POST['rl_slug'] ) ) : '';
		if ( '' === $wanted ) {
			$wanted = sanitize_title( $data['post_title'] );
		}
		if ( '' === $wanted || in_array( $data['post_status'], array( 'auto-draft', 'trash' ), true ) ) {
			return $data;
		}
		$id                = isset( $postarr['ID'] ) ? (int) $postarr['ID'] : 0;
		$data['post_name'] = wp_unique_post_slug( $wanted, $id, $data['post_status'], 'recital_show', 0 );
		return $data;
	},
	10,
	2
);

add_action(
	'save_post_recital_show',
	function ( $post_id ) {
		if ( ! isset( $_POST['recital_live_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['recital_live_nonce'] ) ), 'recital_live_save' ) ) {
			return;
		}
		if ( ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) || wp_is_post_revision( $post_id ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}
		$code = isset( $_POST['rl_crew_code'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['rl_crew_code'] ) ) ) : '';
		update_post_meta( $post_id, '_rl_crew_code', $code );
		update_post_meta( $post_id, '_rl_listed', empty( $_POST['rl_listed'] ) ? '0' : '1' );
		if ( ! empty( $_POST['rl_new_key'] ) ) {
			update_post_meta( $post_id, '_rl_key', wp_generate_password( 32, false ) );
		} else {
			recital_live_key( $post_id );
		}
	}
);

/*
 * Columns on the Shows list.
 */
add_filter(
	'manage_recital_show_posts_columns',
	function ( $cols ) {
		$date = isset( $cols['date'] ) ? $cols['date'] : null;
		unset( $cols['date'] );
		$cols['rl_link'] = __( 'Link for phones', 'recital-live' );
		$cols['rl_last'] = __( 'Last update from the desk', 'recital-live' );
		if ( $date ) {
			$cols['date'] = $date;
		}
		return $cols;
	}
);
add_action(
	'manage_recital_show_posts_custom_column',
	function ( $col, $post_id ) {
		$post = get_post( $post_id );
		if ( 'rl_link' === $col && $post && '' !== $post->post_name && 'publish' === $post->post_status ) {
			$url = recital_live_url( 'page', $post->post_name );
			echo '<a href="' . esc_url( $url ) . '" target="_blank" rel="noopener">' . esc_html( $url ) . '</a>';
		} elseif ( 'rl_last' === $col ) {
			echo esc_html( recital_live_last_update_text( $post_id ) );
		}
	},
	10,
	2
);

/*
 * Friendlier wording for the title box.
 */
add_filter(
	'enter_title_here',
	function ( $text, $post ) {
		return ( $post && 'recital_show' === $post->post_type ) ? __( 'Show name, e.g. Spring Recital 2027', 'recital-live' ) : $text;
	},
	10,
	2
);
