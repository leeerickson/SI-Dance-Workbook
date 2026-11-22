/* Recital Live: Copy button and "Make a new key" check on the Edit show screen. */
(function () {
	'use strict';
	var strings = window.recitalLiveAdmin || { copied: 'Copied', confirmKey: 'Make a new desktop key?' };
	document.addEventListener('click', function (e) {
		var copy = e.target.closest ? e.target.closest('[data-rl-copy]') : null;
		if (copy) {
			e.preventDefault();
			var field = document.getElementById(copy.getAttribute('data-rl-copy'));
			if (!field) return;
			var label = copy.textContent;
			var done = function () {
				copy.textContent = strings.copied;
				setTimeout(function () { copy.textContent = label; }, 1500);
			};
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(field.value).then(done, function () { field.select(); document.execCommand('copy'); done(); });
			} else {
				field.select();
				document.execCommand('copy');
				done();
			}
			return;
		}
		var confirmBtn = e.target.closest ? e.target.closest('[data-rl-confirm]') : null;
		if (confirmBtn && !window.confirm(strings.confirmKey)) e.preventDefault();
	});
})();
