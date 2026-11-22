/*
 * Recital Live phone page.
 * Reads GET /wp-json/recital-live/v1/shows/{slug} every 2 seconds (10 when the page is hidden) and ticks the
 * timers locally between reads, corrected for how old the desk's last status is (server_now - received_at).
 * Everything from the desk is untrusted: it is only ever put on the page with textContent.
 */
(function () {
	'use strict';

	var cfg;
	try {
		cfg = JSON.parse(document.getElementById('rl-config').textContent);
	} catch (e) {
		return;
	}

	var POLL_VISIBLE = 2000;
	var POLL_HIDDEN = 10000;
	var LIVE_SECONDS = 10;
	var TYPES = ['light', 'prop', 'spot', 'sound', 'stage', 'note'];
	var TYPE_NAMES = { light: 'Lighting', prop: 'Props', spot: 'Spot', sound: 'Sound', stage: 'Stage', note: 'Note' };
	var STATE_NAMES = {
		idle: 'Not started',
		standby: 'Standing by',
		playing: 'Playing',
		paused: 'Paused',
		intermission: 'Intermission',
		ended: 'Show over'
	};

	function $(id) { return document.getElementById(id); }

	var store = {
		get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
		set: function (k, v) {
			try {
				if (v === null || v === undefined || v === '') window.localStorage.removeItem(k);
				else window.localStorage.setItem(k, v);
			} catch (e) { /* private mode */ }
		}
	};

	var codeKey = 'recital-live-code:' + cfg.slug;
	var crewCode = store.get(codeKey) || '';
	var filter = [];
	try {
		var saved = JSON.parse(store.get('recital-live-cue-types') || '[]');
		if (Array.isArray(saved)) filter = saved.filter(function (t) { return TYPES.indexOf(t) >= 0; });
	} catch (e) { filter = []; }

	var data = null;        // last response from the site
	var t0 = 0;             // performance.now() when data arrived
	var age0 = 0;           // how old the status was (ms) when data arrived
	var offline = false;
	var everLoaded = false;
	var pollTimer = 0;
	var polling = false;
	var expanded = {};      // program rows the viewer opened, by track id
	var lastCueKey = null;
	var lastSigs = {};

	/* ---------- small helpers ---------- */

	function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
	function str(v) { return (v === null || v === undefined) ? '' : String(v); }
	function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
	function arr(v) { return Array.isArray(v) ? v : []; }

	function fmt(sec) {
		sec = Math.max(0, Math.floor(num(sec)));
		var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
		var ss = (s < 10 ? '0' : '') + s;
		if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
		return m + ':' + ss;
	}
	function fmtUp(sec) { return fmt(Math.ceil(Math.max(0, num(sec)) - 1e-6)); }

	function setText(node, text) {
		text = str(text);
		if (node && node.textContent !== text) node.textContent = text;
	}
	function show(node, yes) { if (node) node.hidden = !yes; }
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined && text !== null) n.textContent = str(text);
		return n;
	}
	function typeClass(t) { return TYPES.indexOf(t) >= 0 ? 't-' + t : 't-note'; }
	function typeName(t) { return TYPE_NAMES[t] || 'Cue'; }
	function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

	/* ---------- reading the data ---------- */

	function tracks() { return data && isObj(data.program) ? arr(data.program.tracks).filter(isObj) : []; }
	function status() { return data && isObj(data.status) ? data.status : null; }
	function isCrew() { return !!(data && data.crew); }
	function ageMs() { return age0 + (performance.now() - t0); }
	function playing() { var s = status(); return !!s && s.state === 'playing'; }

	function currentIndex() {
		var s = status(), list = tracks();
		if (!s) return -1;
		if (s.track_id !== undefined && s.track_id !== null) {
			for (var i = 0; i < list.length; i++) if (list[i].id === s.track_id) return i;
		}
		// index counts from 0 (the protocol example has index 3 for track t4).
		if (typeof s.index === 'number' && s.index >= 0 && s.index < list.length) return Math.floor(s.index);
		return -1;
	}
	function nextIndex(cur) {
		var s = status(), list = tracks();
		if (s && s.next_track_id !== undefined && s.next_track_id !== null) {
			for (var i = 0; i < list.length; i++) if (list[i].id === s.next_track_id) return i;
			return -1;
		}
		if (s && (s.state === 'ended')) return -1;
		if (cur >= 0 && cur + 1 < list.length) return cur + 1;
		if (cur < 0 && s && (s.state === 'idle') && list.length) return 0;
		return -1;
	}
	function trackNumber(t, i) { return (t && t.n !== undefined && t.n !== null && str(t.n) !== '') ? str(t.n) : String(i + 1); }

	function duration(s, t) {
		var d = num(s && s.duration);
		if (d <= 0 && t) d = num(t.duration);
		return d;
	}
	function livePosition(s, t) {
		if (!s) return 0;
		var pos = num(s.position);
		if (s.state === 'playing') pos += (ageMs() / 1000) * (num(s.rate) || 1);
		var d = duration(s, t);
		if (d > 0) pos = Math.min(pos, d);
		return Math.max(0, pos);
	}

	/* Cues for the current number: the track's full cue list when we have it, otherwise what the desk sent. */
	function cueSource(s, t) {
		var list = t ? arr(t.cues).filter(isObj) : [];
		if (!list.length && s) {
			var seen = {};
			var add = function (c) {
				if (!isObj(c)) return;
				var k = num(c.t) + '|' + str(c.type) + '|' + str(c.text);
				if (seen[k]) return;
				seen[k] = 1;
				list.push(c);
			};
			add(s.cue);
			add(s.next_cue);
			arr(s.upcoming_cues).forEach(add);
		}
		return list.slice().sort(function (a, b) { return num(a.t) - num(b.t); });
	}
	function passes(c) { return !filter.length || filter.indexOf(c.type) >= 0; }

	/* ---------- network ---------- */

	function apiUrl(path) { return cfg.api + path; }

	function accept(json, cachedAt) {
		data = json;
		everLoaded = true;
		var srvAge = (json && json.received_at && json.server_now) ? Math.max(0, num(json.server_now) - num(json.received_at)) : 0;
		var extra = cachedAt ? Math.max(0, Date.now() - cachedAt) : 0;
		age0 = srvAge + extra;
		t0 = performance.now();
		render();
	}

	/*
	 * Fast path for everyone without a crew code: a small file the web server hands out without starting
	 * WordPress. The full route is still used on the first load and once a minute (it also sets the clock
	 * correction), and at once if the file can't be read.
	 */
	var clockOffset = null, lastFull = 0, fastBroken = false, FULL_EVERY = 60000;
	function fetchFast() {
		return fetch(cfg.fast + (cfg.fast.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store', credentials: 'omit' }).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		}).then(function (json) {
			if (!isObj(json) || !isObj(json.show)) throw new Error('Bad file');
			json.server_now = Date.now() + clockOffset;
			return { json: json, cached: false, cachedAt: 0 };
		});
	}
	function fetchShow(code) {
		if (!code && cfg.fast && !fastBroken && clockOffset !== null && Date.now() - lastFull < FULL_EVERY) {
			return fetchFast().catch(function () { fastBroken = true; return fetchFull(code); });
		}
		return fetchFull(code);
	}
	function fetchFull(code) {
		var headers = { Accept: 'application/json' };
		if (code) headers['X-Recital-Code'] = code;
		return fetch(apiUrl('shows/' + encodeURIComponent(cfg.slug)), { headers: headers, cache: 'no-store' }).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			var cached = res.headers.get('X-Recital-Offline') === '1';
			var cachedAt = cached ? num(res.headers.get('X-Recital-Fetched')) : 0;
			return res.json().then(function (json) {
				if (!isObj(json)) throw new Error('Bad reply');
				if (!cached && json.server_now) { clockOffset = num(json.server_now) - Date.now(); lastFull = Date.now(); fastBroken = false; }
				return { json: json, cached: cached, cachedAt: cachedAt };
			});
		});
	}

	function schedule() {
		clearTimeout(pollTimer);
		pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN : POLL_VISIBLE);
	}

	function poll() {
		clearTimeout(pollTimer);
		if (polling) return;
		polling = true;
		var sentCode = crewCode;
		fetchShow(sentCode).then(function (r) {
			if (sentCode && sentCode === crewCode && r.json.show && r.json.show.has_code && !r.json.crew && !r.cached) {
				// The studio changed the crew code.
				crewCode = '';
				store.set(codeKey, null);
				setText($('crewMsg'), 'The crew code has changed. Enter the new one to see cues and props.');
			}
			offline = r.cached;
			accept(r.json, r.cachedAt);
		}).catch(function () {
			offline = true;
			tick();
		}).then(function () {
			polling = false;
			schedule();
		});
	}

	/* ---------- rendering ---------- */

	function renderEmpty(s, list) {
		var title = 'The show hasn\'t started yet';
		var text = list.length ? 'Keep this page open. It updates by itself when the show begins.' : 'Keep this page open. The running order and live updates will appear here.';
		if (!everLoaded) { title = 'Connecting…'; text = 'Getting the latest from the show.'; }
		setText($('emptyTitle'), title);
		setText($('emptyText'), text);
	}

	function render() {
		var s = status(), list = tracks();
		var cur = currentIndex(), nxt = nextIndex(cur);
		var state = s ? str(s.state) : '';
		var started = !!s && state !== '' && state !== 'idle';

		if (data && data.show && data.show.title) {
			setText($('showTitle'), data.show.title);
			if (document.title !== str(data.show.title)) document.title = str(data.show.title);
		}

		renderEmpty(s, list);
		show($('empty'), !started);
		show($('now'), started);

		// Up next
		var nt = nxt >= 0 ? list[nxt] : null;
		show($('next'), !!nt && state !== 'ended');
		if (nt) {
			setText($('nextNum'), '#' + trackNumber(nt, nxt));
			setText($('nextDance'), nt.dance || nt.title || 'Next number');
			setText($('nextTitle'), nt.dance ? nt.title : '');
		}

		renderCrew();
		renderProgram(cur);
		renderProps(s, cur, nxt);
		tick();
	}

	function renderNow(s, list, cur) {
		var state = s ? str(s.state) : '';
		var t = cur >= 0 ? list[cur] : null;
		var stateNode = $('state');
		setText(stateNode, STATE_NAMES[state] || '');
		stateNode.className = 'state ' + (STATE_NAMES[state] ? state : '');

		var timed = state === 'playing' || state === 'paused' || state === 'standby';
		show(document.querySelector('#now .progress'), timed);
		show(document.querySelector('#now .timers'), timed);

		if (state === 'intermission') {
			setText($('nowNum'), '');
			setText($('nowDance'), 'Intermission');
			setText($('nowTitle'), (s.filler && s.filler.playing && s.filler.title) ? 'Playing: ' + str(s.filler.title) : '');
			setText($('nowClass'), '');
			return;
		}
		if (state === 'ended') {
			setText($('nowNum'), '');
			setText($('nowDance'), 'That\'s the show!');
			setText($('nowTitle'), 'Thank you for coming.');
			setText($('nowClass'), '');
			return;
		}
		if (t) {
			setText($('nowNum'), '#' + trackNumber(t, cur) + ' of ' + list.length);
			setText($('nowDance'), t.dance || t.title || '');
			setText($('nowTitle'), t.dance ? t.title : '');
			setText($('nowClass'), t['class'] || '');
		} else {
			setText($('nowNum'), (typeof s.index === 'number') ? '#' + (Math.floor(s.index) + 1) : '');
			setText($('nowDance'), 'Number ' + ((typeof s.index === 'number') ? Math.floor(s.index) + 1 : ''));
			setText($('nowTitle'), '');
			setText($('nowClass'), '');
		}
		var d = duration(s, t), pos = livePosition(s, t);
		setText($('elapsed'), fmt(pos));
		setText($('remaining'), d > 0 ? '\u2212' + fmtUp(d - pos) : '–');
		$('bar').style.width = (d > 0 ? Math.min(100, (pos / d) * 100) : 0).toFixed(2) + '%';
	}

	function renderCues(s, list, cur) {
		var t = cur >= 0 ? list[cur] : null;
		var anyCues = false;
		if (isCrew()) {
			if (s && (s.cue || s.next_cue || arr(s.upcoming_cues).length)) anyCues = true;
			for (var i = 0; !anyCues && i < list.length; i++) if (arr(list[i].cues).length) anyCues = true;
		}
		var state = s ? str(s.state) : '';
		var active = state === 'playing' || state === 'paused' || state === 'standby';
		show($('cues'), anyCues);
		if (!anyCues) return;

		var pos = active ? livePosition(s, t) : 0;
		var all = active ? cueSource(s, t).filter(passes) : [];
		var now = null, next = null, upcoming = [];
		all.forEach(function (c) {
			if (num(c.t) <= pos) now = c;
			else upcoming.push(c);
		});
		next = upcoming[0] || null;

		var cueNow = $('cueNow');
		cueNow.className = 'cue-now ' + (now ? typeClass(now.type) : '');
		setText(cueNow.querySelector('.cue-type'), now ? typeName(now.type) + ' · ' + fmt(now.t) : 'Current cue');
		setText(cueNow.querySelector('.cue-text'), now ? now.text : (active ? 'No cue yet' : 'Cues appear when a number is on'));
		var key = now ? (t ? str(t.id) : '') + '|' + num(now.t) + '|' + str(now.text) : '';
		if (lastCueKey !== null && key && key !== lastCueKey) {
			cueNow.classList.remove('flash');
			void cueNow.offsetWidth; // restart the animation
			cueNow.classList.add('flash');
			if (navigator.vibrate && document.visibilityState === 'visible') { try { navigator.vibrate(60); } catch (e) { /* ignore */ } }
		}
		lastCueKey = key;

		var nextWrap = $('cueNextWrap');
		nextWrap.className = 'cue-next ' + (next ? typeClass(next.type) : '');
		setText($('cueNext'), next ? next.text : 'No more cues in this number');
		setText($('cueIn'), next ? 'in ' + fmtUp(num(next.t) - pos) : '');

		var listNode = $('cueList');
		var sig = (t ? str(t.id) : '') + '#' + upcoming.slice(1, 13).map(function (c) { return num(c.t) + str(c.type) + str(c.text); }).join('|');
		if (lastSigs.cues !== sig) {
			lastSigs.cues = sig;
			clear(listNode);
			upcoming.slice(1, 13).forEach(function (c) {
				var li = el('li', typeClass(c.type));
				li.appendChild(el('span', 'when', fmt(c.t)));
				li.appendChild(el('span', 'tag', typeName(c.type)));
				li.appendChild(el('span', 'what', c.text));
				listNode.appendChild(li);
			});
		}
	}

	function fillList(node, items, emptyText) {
		clear(node);
		items = arr(items).filter(function (p) { return str(p) !== ''; });
		if (!items.length) { node.appendChild(el('li', 'muted', emptyText)); return; }
		items.forEach(function (p) { node.appendChild(el('li', '', p)); });
	}

	function renderProps(s, cur, nxt) {
		var list = tracks();
		var t = cur >= 0 ? list[cur] : null, nt = nxt >= 0 ? list[nxt] : null;
		var nowProps = s && Array.isArray(s.props) ? s.props : (t ? arr(t.props) : []);
		var nextProps = nt ? arr(nt.props) : [];
		var any = false;
		if (isCrew()) {
			if (s && arr(s.props).length) any = true;
			for (var i = 0; !any && i < list.length; i++) if (arr(list[i].props).length) any = true;
		}
		show($('props'), any);
		if (!any) return;
		var state = s ? str(s.state) : '';
		if (state === 'intermission' || state === 'idle' || !s) nowProps = [];
		fillList($('propsNow'), nowProps, 'None');
		fillList($('propsNext'), nextProps, nt ? 'None' : '—');
	}

	function renderCrew() {
		var hasCode = data && data.show ? !!data.show.has_code : !!cfg.hasCode;
		show($('crewBox'), hasCode);
		var on = hasCode && isCrew();
		show($('crewForm'), !on);
		show($('crewOn'), on);
	}

	function renderProgram(cur) {
		var list = tracks(), node = $('programList');
		show($('programEmpty'), !list.length);
		var s = status();
		var ended = s && s.state === 'ended';
		var sig = JSON.stringify([data && data.program ? data.program.updated : 0, list.length, cur, ended, isCrew(), expanded,
			list.map(function (t) { return [t.id, t.n, t.title, t.dance, t.duration]; })]);
		if (lastSigs.program === sig) return;
		lastSigs.program = sig;
		clear(node);
		list.forEach(function (t, i) {
			var li = el('li');
			if (ended || (cur >= 0 && i < cur)) li.className = 'done';
			else if (i === cur) li.className = 'current';
			var id = str(t.id !== undefined ? t.id : i);
			var btn = el('button', 'row');
			btn.type = 'button';
			btn.setAttribute('aria-expanded', expanded[id] ? 'true' : 'false');
			btn.appendChild(el('span', 'n', trackNumber(t, i)));
			var names = el('span', 'names');
			names.appendChild(el('span', 'pd', t.dance || t.title || ''));
			if (t.dance && t.title) names.appendChild(el('span', 'pt', t.title));
			btn.appendChild(names);
			btn.appendChild(el('span', 'dur', num(t.duration) > 0 ? fmt(t.duration) : ''));
			btn.addEventListener('click', function () {
				if (expanded[id]) delete expanded[id]; else expanded[id] = 1;
				renderProgram(currentIndex());
			});
			li.appendChild(btn);
			if (expanded[id]) li.appendChild(details(t));
			if (i === cur && !ended) li.setAttribute('aria-current', 'step');
			node.appendChild(li);
		});
	}

	function details(t) {
		var d = el('div', 'details');
		if (t['class']) d.appendChild(el('p', '', 'Class: ' + str(t['class'])));
		if (t.transition === 'straight') d.appendChild(el('p', 'muted', 'Goes straight into the next number.'));
		if (t.transition === 'crossfade') d.appendChild(el('p', 'muted', 'Fades into the next number.'));
		if (isCrew()) {
			if (t.notes) d.appendChild(el('p', '', str(t.notes)));
			var props = arr(t.props);
			if (props.length) d.appendChild(el('p', '', 'Props: ' + props.map(str).join(', ')));
			var cues = arr(t.cues).filter(isObj).slice().sort(function (a, b) { return num(a.t) - num(b.t); });
			if (cues.length) {
				var ul = el('ul');
				cues.forEach(function (c) {
					var li = el('li', typeClass(c.type));
					li.appendChild(el('span', 'when', fmt(c.t)));
					li.appendChild(el('span', 'tag', typeName(c.type)));
					li.appendChild(el('span', '', c.text));
					ul.appendChild(li);
				});
				d.appendChild(ul);
			}
		}
		if (!d.firstChild) d.appendChild(el('p', 'muted', 'No more details for this number.'));
		return d;
	}

	/* Runs every 250 ms: timers, countdowns and the connection light. */
	function tick() {
		var s = status(), list = tracks(), cur = currentIndex();
		if (s && s.state && s.state !== 'idle') renderNow(s, list, cur);
		renderCues(s, list, cur);

		// Message and intermission countdown
		var msg = s ? str(s.message) : '';
		var hasCount = s && s.countdown_left !== undefined && s.countdown_left !== null && num(s.countdown_left) > 0;
		var left = hasCount ? Math.max(0, num(s.countdown_left) - ageMs() / 1000) : 0;
		show($('banner'), !!msg || hasCount);
		setText($('msgText'), msg);
		show($('msgText'), !!msg);
		show($('countdownWrap'), hasCount);
		if (hasCount) {
			setText($('countdownLabel'), s.state === 'intermission' ? 'Back in' : 'Starts in');
			setText($('countdown'), left > 0 ? fmtUp(left) : 'Any moment now');
		}

		// Whole show time left
		var hasLeft = s && s.show_remaining !== undefined && s.show_remaining !== null && s.state !== 'ended' && s.state !== 'idle';
		show($('showLeftWrap'), !!hasLeft);
		if (hasLeft) {
			var sl = num(s.show_remaining) - (playing() ? (ageMs() / 1000) * (num(s.rate) || 1) : 0);
			setText($('showLeft'), fmtUp(sl));
		}

		// Connection light
		var conn = $('conn'), text, cls;
		if (offline) { text = 'Offline'; cls = 'off'; }
		else if (!everLoaded) { text = 'Connecting…'; cls = ''; }
		else if (data && data.received_at) {
			var a = ageMs() / 1000;
			if (a <= LIVE_SECONDS) { text = 'Live'; cls = 'live'; }
			else { text = 'Last update ' + ago(a); cls = 'stale'; }
		} else { text = 'Live'; cls = 'live'; }
		setText($('connText'), text);
		conn.className = 'conn ' + cls;
		show($('offline'), offline && everLoaded);
	}

	function ago(sec) {
		sec = Math.floor(sec);
		if (sec < 60) return sec + ' s ago';
		if (sec < 3600) return Math.floor(sec / 60) + ' min ago';
		if (sec < 172800) return Math.floor(sec / 3600) + ' h ago';
		return Math.floor(sec / 86400) + ' days ago';
	}

	/* ---------- cue type filter chips ---------- */

	Array.prototype.forEach.call(document.querySelectorAll('#chips .chip'), function (chip) {
		var type = chip.getAttribute('data-type');
		chip.classList.add(typeClass(type));
		chip.setAttribute('aria-pressed', filter.indexOf(type) >= 0 ? 'true' : 'false');
		chip.addEventListener('click', function () {
			var i = filter.indexOf(type);
			if (i >= 0) filter.splice(i, 1); else filter.push(type);
			chip.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
			store.set('recital-live-cue-types', filter.length ? JSON.stringify(filter) : null);
			lastSigs.cues = null;
			lastCueKey = null;
			tick();
		});
	});

	/* ---------- crew code ---------- */

	$('crewForm').addEventListener('submit', function (e) {
		e.preventDefault();
		var code = $('crewCode').value.trim();
		var msg = $('crewMsg');
		if (!code) { setText(msg, 'Type the crew code first.'); return; }
		setText(msg, '');
		fetchShow(code).then(function (r) {
			if (r.cached) { setText(msg, 'You\'re offline, so the code can\'t be checked right now. Try again in a moment.'); return; }
			if (r.json.crew) {
				crewCode = code;
				store.set(codeKey, code);
				$('crewCode').value = '';
				offline = false;
				accept(r.json, 0);
			} else {
				setText(msg, 'That code isn\'t right. Check it with the stage manager and try again.');
			}
		}).catch(function () {
			setText(msg, 'Couldn\'t check the code. Make sure you\'re connected and try again.');
		});
	});
	$('crewForget').addEventListener('click', function () {
		crewCode = '';
		store.set(codeKey, null);
		lastSigs = {};
		poll();
	});

	/* ---------- other shows ---------- */

	function loadShows() {
		fetch(apiUrl('shows'), { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (r) {
			return r.ok ? r.json() : null;
		}).then(function (json) {
			var shows = json && Array.isArray(json.shows) ? json.shows.filter(isObj) : [];
			var others = shows.filter(function (s) { return s.slug !== cfg.slug; });
			var sel = $('otherShows');
			clear(sel);
			if (!others.length) { show($('otherWrap'), false); return; }
			var here = el('option', '', 'Other shows…');
			here.value = '';
			here.selected = true;
			sel.appendChild(here);
			others.forEach(function (s) {
				var url;
				try { url = new URL(str(s.url), location.href); } catch (e) { return; }
				if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
				var o = el('option', '', s.title || s.slug);
				o.value = url.href;
				sel.appendChild(o);
			});
			show($('otherWrap'), sel.options.length > 1);
		}).catch(function () { /* keep the menu hidden */ });
	}
	$('otherShows').addEventListener('change', function () {
		if (this.value) window.location.href = this.value;
	});

	/* ---------- keep the screen on ---------- */

	var wakeLock = null, wantWake = false;
	function setWake(on) {
		wantWake = on;
		var btn = $('wakeBtn');
		if (on) {
			navigator.wakeLock.request('screen').then(function (lock) {
				wakeLock = lock;
				btn.setAttribute('aria-pressed', 'true');
				setText(btn, 'Screen stays on (tap to stop)');
				lock.addEventListener('release', function () {
					wakeLock = null;
					if (!wantWake) { btn.setAttribute('aria-pressed', 'false'); setText(btn, 'Keep screen on'); }
				});
			}).catch(function () {
				wantWake = false;
				setText(btn, 'Keep screen on (not allowed here)');
			});
		} else {
			if (wakeLock) wakeLock.release();
			wakeLock = null;
			btn.setAttribute('aria-pressed', 'false');
			setText(btn, 'Keep screen on');
		}
	}
	if ('wakeLock' in navigator) {
		show($('wakeBtn'), true);
		$('wakeBtn').addEventListener('click', function () { setWake(!wantWake); });
	}

	/* ---------- Add to Home Screen ---------- */

	var installEvent = null;
	var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
	window.addEventListener('beforeinstallprompt', function (e) {
		e.preventDefault();
		installEvent = e;
		show($('installBtn'), true);
	});
	$('installBtn').addEventListener('click', function () {
		if (!installEvent) return;
		installEvent.prompt();
		installEvent.userChoice.then(function () { installEvent = null; show($('installBtn'), false); }, function () {});
	});
	window.addEventListener('appinstalled', function () { show($('installBtn'), false); });
	var ua = navigator.userAgent || '';
	var isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	if (isIOS && !standalone && window.top === window.self) show($('iosHint'), true);

	/* ---------- offline support ---------- */

	if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
		navigator.serviceWorker.register(cfg.sw, { scope: cfg.scope }).then(function () {
			return navigator.serviceWorker.ready;
		}).then(function (reg) {
			if (reg.active) reg.active.postMessage({ type: 'recital-cache-page', url: location.href });
		}).catch(function () { /* offline support is a bonus */ });
	}

	/* ---------- start ---------- */

	document.addEventListener('visibilitychange', function () {
		if (!document.hidden) {
			poll();
			if (wantWake && !wakeLock) setWake(true);
		} else {
			schedule();
		}
	});
	window.addEventListener('online', poll);
	window.addEventListener('offline', function () { offline = true; tick(); });

	render();
	poll();
	loadShows();
	setInterval(tick, 250);
	setInterval(loadShows, 5 * 60 * 1000);
})();
