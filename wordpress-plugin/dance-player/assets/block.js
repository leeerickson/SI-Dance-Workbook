/* Dance Player block (no build step: plain wp.element). */
(function (wp) {
	var el = wp.element.createElement, __ = wp.i18n.__;
	var be = wp.blockEditor, C = wp.components;
	wp.blocks.registerBlockType('dance-player/player', {
		apiVersion: 2,
		title: __('Dance Player', 'dance-player'),
		description: __('Play a .dance file: counts, notes, formations, props and music.', 'dance-player'),
		icon: 'format-audio',
		category: 'media',
		keywords: ['dance', 'choreography', 'formation'],
		attributes: {
			fileId: { type: 'number' }, fileUrl: { type: 'string', default: '' }, name: { type: 'string', default: '' },
			open: { type: 'boolean', default: true }, width: { type: 'number', default: 480 }
		},
		edit: function (props) {
			var a = props.attributes, set = props.setAttributes, blockProps = be.useBlockProps({ className: 'dance-player-editor' });
			var pick = el(be.MediaUploadCheck, null, el(be.MediaUpload, {
				onSelect: function (m) { set({ fileId: m.id, fileUrl: m.url, name: m.filename || m.title || '' }); },
				allowedTypes: ['application/zip'], value: a.fileId,
				render: function (o) { return el(C.Button, { variant: a.fileId ? 'secondary' : 'primary', onClick: o.open }, a.fileId ? __('Choose a different .dance file', 'dance-player') : __('Choose a .dance file', 'dance-player')); }
			}));
			return el('div', blockProps,
				el(be.InspectorControls, null, el(C.PanelBody, { title: __('Dance Player', 'dance-player') },
					el(C.ToggleControl, { label: __('Let visitors open their own .dance files', 'dance-player'), checked: a.open, onChange: function (v) { set({ open: v }); } }),
					el(C.RangeControl, { label: __('Width (pixels)', 'dance-player'), value: a.width, min: 320, max: 1200, step: 20, onChange: function (v) { set({ width: v }); } }))),
				el(C.Placeholder, { icon: 'format-audio', label: __('Dance Player', 'dance-player'),
					instructions: a.fileId ? __('Playing: ', 'dance-player') + (a.name || a.fileUrl) : __('Choose a .dance file from the Media Library, or leave it empty so visitors open their own.', 'dance-player') }, pick)
			);
		},
		save: function () { return null; }
	});
})(window.wp);
