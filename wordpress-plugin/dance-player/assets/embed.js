/* Dance Player: grow each player iframe to the height of its content, so there's no inner scrollbar. */
(function () {
	window.addEventListener('message', function (e) {
		if (!e.data || e.data.type !== 'dance-player-height') return;
		var frames = document.querySelectorAll('iframe.dance-player-frame');
		for (var i = 0; i < frames.length; i++) {
			if (frames[i].contentWindow === e.source) frames[i].style.height = Math.max(400, Math.min(4000, e.data.h | 0)) + 'px';
		}
	});
})();
