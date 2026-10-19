/* Coregate server page: the glue between the page, the map renderer and the server's
 * own API. Owner actions are signed with the admin password exactly the way the
 * launcher and the panel sign them (HMAC-SHA256 over method, path, time and body),
 * so nothing new listens anywhere. The password never leaves this browser: it is
 * kept in localStorage per server and only ever used to compute signatures.
 *
 * The page is served over plain HTTP from a game server, where WebCrypto is not
 * available, so SHA-256 and HMAC are done in plain script below.
 */
(function () {
	'use strict';

	// ---- SHA-256 + HMAC (FIPS 180-4), byte arrays in, byte arrays out -----------------------
	var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
	function sha256(msg) {
		var l = msg.length, padLen = ((l + 9 + 63) >> 6) << 6, p = new Uint8Array(padLen);
		p.set(msg); p[l] = 0x80;
		var bits = l * 8; p[padLen - 4] = (bits >>> 24) & 255; p[padLen - 3] = (bits >>> 16) & 255; p[padLen - 2] = (bits >>> 8) & 255; p[padLen - 1] = bits & 255;
		var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Array(64);
		for (var off = 0; off < padLen; off += 64) {
			for (var i = 0; i < 16; i++) W[i] = (p[off + i * 4] << 24) | (p[off + i * 4 + 1] << 16) | (p[off + i * 4 + 2] << 8) | p[off + i * 4 + 3];
			for (i = 16; i < 64; i++) { var w15 = W[i - 15], w2 = W[i - 2]; var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3); var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
			var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
			for (i = 0; i < 64; i++) {
				var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)); var ch = (e & f) ^ (~e & g); var t1 = (h + S1 + ch + K[i] + W[i]) | 0;
				var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)); var maj = (a & b) ^ (a & c) ^ (b & c); var t2 = (S0 + maj) | 0;
				h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
			}
			H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
		}
		var out = new Uint8Array(32);
		for (i = 0; i < 8; i++) { out[i * 4] = (H[i] >>> 24) & 255; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; }
		return out;
	}
	function hmac(key, msg) {
		if (key.length > 64) key = sha256(key);
		var ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 32);
		for (var i = 0; i < 64; i++) { var k = i < key.length ? key[i] : 0; ipad[i] = k ^ 0x36; opad[i] = k ^ 0x5c; }
		ipad.set(msg, 64); opad.set(sha256(ipad), 64);
		return sha256(opad);
	}
	function utf8(s) { return new TextEncoder().encode(s); }
	function hex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
	function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
	window.wgSha256Hex = function (s) { return hex(sha256(utf8(s))); };   // for the self-check in the tests

	// ---- the signed client ---------------------------------------------------------------------------
	var STORE = 'coregate.admin.' + location.host, LEGACY_STORE = 'waygate.admin.' + location.host;
	var password = null, key = null, unlocked = false;
	try {
		password = localStorage.getItem(STORE) || null;
		if (!password) { password = localStorage.getItem(LEGACY_STORE) || null; if (password) localStorage.setItem(STORE, password); }
		localStorage.removeItem(LEGACY_STORE);
	} catch (e) { password = null; }
	function setPassword(p) { password = p || null; key = password ? sha256(utf8(password)) : null; try { if (password) localStorage.setItem(STORE, password); else localStorage.removeItem(STORE); } catch (e) {} }
	if (password) key = sha256(utf8(password));

	function signature(method, path, bodyStr, ts) {
		var canonical = method + '\n' + path + '\n' + ts + '\n' + hex(sha256(utf8(bodyStr || '')));
		return hex(hmac(key, utf8(canonical)));
	}
	// Signed requests. A JSON body for POST; null body for GET. The reply is parsed JSON or
	// null; a 401 is reported as { unauthorized: true } so the page can ask for the password.
	function call(method, path, body, cb, timeoutMs) {
		var payload = body ? JSON.stringify(body) : '';
		var xhr = new XMLHttpRequest();
		xhr.open(method, path, true);
		xhr.timeout = timeoutMs || 20000;
		if (key) {
			var ts = Math.floor(Date.now() / 1000);
			xhr.setRequestHeader('X-Waygate-Timestamp', String(ts));
			xhr.setRequestHeader('X-Waygate-Signature', signature(method, path.split('?')[0], payload, ts));
		}
		if (body) xhr.setRequestHeader('Content-Type', 'application/json');
		xhr.onload = function () { var d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = null; } if (xhr.status === 401) { cb({ unauthorized: true, error: (d && d.error) || 'unauthorized' }); return; } if (xhr.status === 503 && d) { d.offline = true; } cb(d); };
		xhr.onerror = function () { cb(null); };
		xhr.ontimeout = function () { cb(null); };
		xhr.send(payload || null);
	}
	function get(path, cb) { call('GET', path, null, cb); }
	function post(path, body, cb, timeoutMs) { call('POST', path, body || {}, cb, timeoutMs); }
	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	function $(id) { return document.getElementById(id); }
	function spanOf(sec) { sec = Math.max(0, parseInt(sec, 10) || 0); if (sec < 60) return 'a few seconds'; var m = Math.floor(sec / 60), h = Math.floor(m / 60); m = m % 60; if (!h) return m + (m === 1 ? ' minute' : ' minutes'); return m ? (h + 'h ' + m + 'm') : (h + (h === 1 ? ' hour' : ' hours')); }
	function result(id, d, okText) { var e = $(id); if (!e) return; var good = !!d && !d.error && d.ok !== false; e.className = 'wg-result' + (good ? ' good' : ' bad'); e.textContent = good ? (okText || d.result || 'Done.') : ((d && (d.error || d.result)) || 'That did not go through. Try again.'); }

	// ---- the page's own dropdown ----------------------------------------------------------------------
	// A native <select> pops the operating system's list, which no stylesheet reaches, so a
	// one-of-few picker is a button and a list in the page's tokens. Keyboard: Enter/Space/
	// ArrowDown open, arrows move, Enter picks, Escape closes; touch: tap. The element gets a
	// .value property and fires 'change' like the control it replaces.
	function makeSelect(host, options, current) {
		host.innerHTML = '<button type="button" class="wg-select-btn" aria-haspopup="listbox" aria-expanded="false"><span class="wg-select-val"></span><span class="wg-caret"></span></button><ul class="wg-select-list" role="listbox"></ul>';
		var btn = host.firstChild, list = host.lastChild, opts = [], value = current == null ? '' : String(current), hot = -1;
		function label() { for (var i = 0; i < opts.length; i++) { if (opts[i].value === value) return opts[i].label; } return opts.length ? opts[0].label : ''; }
		function paint() {
			btn.firstChild.textContent = label(); list.innerHTML = '';
			for (var i = 0; i < opts.length; i++) { var li = document.createElement('li'); li.setAttribute('role', 'option'); li.setAttribute('data-value', opts[i].value); li.setAttribute('aria-selected', opts[i].value === value ? 'true' : 'false'); li.textContent = opts[i].label; if (i === hot) li.className = 'hot'; list.appendChild(li); }
		}
		function close() { host.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); hot = -1; }
		function open() {
			var others = document.querySelectorAll('.wg-select.open'); for (var i = 0; i < others.length; i++) others[i].classList.remove('open');
			host.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
			var r = btn.getBoundingClientRect(); host.classList.toggle('up', r.bottom + 270 > window.innerHeight);
			hot = -1; for (var j = 0; j < opts.length; j++) if (opts[j].value === value) hot = j; paint();
		}
		function pick(v) { var was = value; value = v; close(); paint(); if (was !== value) host.dispatchEvent(new Event('change')); }
		btn.addEventListener('click', function () { if (host.classList.contains('open')) close(); else open(); });
		btn.addEventListener('keydown', function (ev) {
			var isOpen = host.classList.contains('open');
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (!isOpen) { open(); return; } hot = (hot + (ev.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; paint(); return; }
			if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (!isOpen) { open(); return; } if (hot >= 0) pick(opts[hot].value); return; }
			if (ev.key === 'Escape' && isOpen) { ev.preventDefault(); close(); }
		});
		list.addEventListener('click', function (ev) { var li = ev.target.closest('li'); if (li) { pick(li.getAttribute('data-value')); btn.focus(); } });
		document.addEventListener('click', function (ev) { if (!host.contains(ev.target)) close(); });
		Object.defineProperty(host, 'value', { get: function () { return value; }, set: function (v) { value = String(v == null ? '' : v); paint(); } });
		host.setOptions = function (list2, keep) { opts = list2; if (!keep || !opts.some(function (o) { return o.value === value; })) value = opts.length ? opts[0].value : ''; paint(); };
		host.setOptions(options, true);
		return host;
	}
	makeSelect($('wgconSource'), [{ value: '', label: 'everything' }, { value: 'chat', label: 'chat' }, { value: 'join,leave', label: 'joins and leaves' }, { value: 'admin,rcon,panel,web', label: 'admin actions' }, { value: 'death', label: 'deaths' }, { value: 'game', label: 'the game only' }, { value: 'waygate', label: 'the server only' }], '');
	makeSelect($('wgAlEvery'), [{ value: '0', label: 'never' }, { value: '1', label: 'every hour' }, { value: '3', label: 'every 3 hours' }, { value: '6', label: 'every 6 hours' }, { value: '24', label: 'once a day' }], '0');

	// ---- unlock ---------------------------------------------------------------------------------------
	var info = null;
	function tryUnlock(p, resultId, then) {
		if (!p) { result(resultId, { error: 'Type the admin password first.' }); return; }
		setPassword(p);
		get('/api/v1/status', function (d) {
			if (!d || d.unauthorized) { setPassword(null); unlocked = false; result(resultId, { error: (d && d.error && /no admin password/.test(d.error)) ? 'This server has no admin password set, so there is nothing to unlock.' : 'That password was not accepted.' }); return; }
			unlocked = true; paintLock(); result(resultId, d, 'Unlocked.'); if (then) then();
		});
	}
	function paintLock() {
		$('wgUnlock').textContent = unlocked ? 'Lock' : 'Unlock';
		$('wgConLocked').style.display = unlocked ? 'none' : 'flex'; $('wgConWrap').style.display = unlocked ? 'flex' : 'none';
		$('wgAlLocked').style.display = unlocked ? 'none' : 'flex'; $('wgAlWrap').style.display = unlocked ? 'block' : 'none';
		$('wgBansCard').style.display = unlocked ? '' : 'none';
		$('wgPlHint').textContent = unlocked ? 'Everyone connected right now, with where they are.' : 'Everyone connected right now, with where they are. Unlock to remove or block someone.';
		if (unlocked) { if (booted.console) { booted.console = false; if (activeTab === 'console') activate('console'); } if (booted.alerts) { booted.alerts = false; if (activeTab === 'alerts') activate('alerts'); } if (booted.players) { booted.players = false; if (activeTab === 'players') activate('players'); } }
		$('wgLockModal').classList.remove('open');
	}
	$('wgUnlock').addEventListener('click', function () {
		if (unlocked) { setPassword(null); unlocked = false; paintLock(); detachStream(''); return; }
		$('wgLockModal').classList.add('open'); setTimeout(function () { $('wgLockPass').focus(); }, 50);
	});
	$('wgLockGo').addEventListener('click', function () { tryUnlock($('wgLockPass').value, 'wgLockResult'); });
	$('wgLockPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('wgLockGo').click(); });
	$('wgConUnlock').addEventListener('click', function () { tryUnlock($('wgConPass').value, 'wgConLockResult'); });
	$('wgConPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('wgConUnlock').click(); });
	$('wgAlUnlock').addEventListener('click', function () { tryUnlock($('wgAlPass').value, 'wgAlLockResult'); });
	$('wgAlPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('wgAlUnlock').click(); });
	var closers = document.querySelectorAll('[data-close]');
	for (var ci = 0; ci < closers.length; ci++) closers[ci].addEventListener('click', function () { this.closest('.wg-modal').classList.remove('open'); });
	$('wgHelp').addEventListener('click', function () { $('wgHelpModal').classList.add('open'); });

	// ---- header + rail --------------------------------------------------------------------------------
	function setState(kind, text) { var p = $('wgState'); p.className = 'wg-pill' + (kind ? ' ' + kind : ''); p.querySelector('span').textContent = text; }
	function loadInfo() {
		get('/api/v1/web', function (d) {
			if (!d) { setState('err', 'No answer'); return; }
			info = d;
			document.title = (d.server_name || 'Coregate') + ' - Coregate';
			$('wgServer').textContent = d.server_name || 'Coregate server';
			$('wgCount').textContent = (d.player_count != null ? d.player_count : '-') + ' / ' + (d.max_players || '-') + ' players';
			if (d.hosting) setState('live', 'Live'); else setState('warn', d.verdict && d.verdict !== 'HOSTING' ? d.verdict.toLowerCase().replace(/_/g, ' ') : 'Starting up');
			if (!d.has_password) { $('wgUnlock').style.display = 'none'; }
		});
	}
	var lastRail = null;
	function paintRail(r) {
		lastRail = r;
		var host = $('wgRailBody'), ps = r.players || [];
		$('wgDockCount').textContent = ps.length;
		$('wgRailHead').textContent = window.innerWidth <= 900 ? (ps.length + ' playing') : 'Who is playing';
		if (r.running === false) { host.innerHTML = '<div class="wg-empty">The server is offline.</div>'; return; }
		if (!r.live) { host.innerHTML = '<div class="wg-empty">' + (r.everLive ? 'The server stopped answering. It may be restarting.' : 'Listening to the server…') + '</div>'; return; }
		if (!ps.length) { host.innerHTML = '<div class="wg-empty">Nobody is playing right now.</div>'; $('wgRailFoot').textContent = 'Updated just now'; return; }
		host.innerHTML = ps.map(function (p) {
			var pct = (p.hp_max > 0) ? Math.max(0, Math.min(100, Math.round(p.hp / p.hp_max * 100))) : null;
			return '<div class="wg-prow" data-name="' + esc(p.name) + '"><div class="nm"><span class="sw" style="background:' + esc(p.color) + '"></span><span>' + esc(p.name) + '</span>' + (p.level ? '<span class="lv">Lv ' + esc(p.level) + '</span>' : '') + '</div>'
				+ '<div class="mt"><span>' + esc(p.area) + '</span>' + (p.dead ? '<em>down</em>' : '') + (p.sleeping ? '<em>asleep</em>' : '') + (pct === null ? '' : '<span class="wg-hp"><i class="' + (pct < 35 ? 'hurt' : '') + '" style="width:' + pct + '%"></i></span>') + '</div>'
				+ (unlocked ? '<div class="wg-pacts"><button type="button" data-act="kick" class="danger">Remove</button><button type="button" data-act="ban" class="danger">Block</button></div>' : '') + '</div>';
		}).join('');
		$('wgRailFoot').textContent = 'Updated just now';
	}
	$('wgRailBody').addEventListener('click', function (ev) {
		var btn = ev.target.closest('button[data-act]'); if (!btn) return;
		var name = btn.closest('.wg-prow').getAttribute('data-name'), act = btn.getAttribute('data-act');
		if (!confirm(act === 'kick' ? 'Remove ' + name + ' from the server? They can join again straight away.' : 'Block ' + name + '? They are removed and kept out until you unblock them.')) return;
		btn.disabled = true;
		post(act === 'kick' ? '/api/v1/players/kick' : '/api/v1/bans', { name: name, by: 'web' }, function (d) { btn.disabled = false; if (!d || d.error || d.unauthorized) alert((d && d.error) || 'That did not go through.'); else if (map) map.refresh(); });
	});
	$('wgDockBtn').addEventListener('click', function () { $('wgRail').classList.toggle('open'); });
	$('wgRailHead').addEventListener('click', function () { if (window.innerWidth <= 900) $('wgRail').classList.toggle('open'); });

	// ---- map ------------------------------------------------------------------------------------------------
	var map = null;
	function pollMap(done) {
		get('/api/v1/map', function (d) {
			if (!d) { done(null); return; }
			if (d.unauthorized) { done({ running: true, map: null, status: { verdict: 'HOSTING', map_feed: true } }); return; }
			if (d.error) { done({ running: d.hosting !== false, map: null, status: { verdict: d.hosting === false ? 'STARTING' : 'HOSTING', map_feed: true } }); return; }
			done({ running: true, map: d, status: { verdict: 'HOSTING', map_feed: true } });
		});
	}
	function bootMap() {
		if (map) { map.start(); return; }
		map = window.DimraethCompass.mount({
			root: $('wgMap'), mode: 'web', assets: '/maps/', catalogUrl: '/maps/world.json', markersUrl: '/assets/markers.webp', markers2Url: '/assets/markers2.webp', poll: pollMap, pollMs: 5000,
			show: { positions: true, health: true, names: true, offline: true },
			fog: (info && info.fog_of_war === 'world') ? 'world' : 'off',   // [Web] FogOfWar; the layers menu can switch it once unlocked
			onLive: paintRail,
			onStatus: function (s) { if (s.live && s.live.players) $('wgCount').textContent = s.live.players.length + ' / ' + ((info && info.max_players) || '-') + ' players'; }
		});
		map.start();
	}

	// ---- console -------------------------------------------------------------------------------------------
	var conSeq = 0, conMine = [], conStream = null, conHistory = [], conHistoryAt = -1, conRetry = null;
	function wantSource(src) { var want = $('wgconSource').value; if (!want) return true; return want.split(',').indexOf(src) >= 0; }
	// The feed carries boot milestones in plain words, joins, leaves, chat, saves, admin
	// actions, deaths and warnings that mean something; the host's own machinery lines and
	// the game's headless boot noise are dropped here as well as on the server.
	var MACHINE = /map feed|stand-in|no host character|NetworkManager|world scenes|scene handlers|chat relay|connected clients|version badge|Chainloader|frame cap|host alive|seats:|world settings:|lock buildings to owner|ghost host|starting\.\.\.|replicated:|access:|render path shader|MudtekIntro|VideoPlayer|FMOD|ERR_OUTPUT_INIT|UIFX|BoxBlur|Il2Cpp|interop|BepInEx|Chainloader|FacepunchTransport|SteamApi_Init|Steam client|Developer private key|status\.json|commands\.txt|map\.json|map-wanted|A2S|boot-report|\.php/i;
	var MILESTONES = [
		[/^creating world '([^']+)'/i, function (m) { return "Creating a new world '" + m[1] + "'"; }],
		[/^starting host: world='([^']+)'/i, function (m) { return "Starting the world '" + m[1] + "'"; }],
		[/^world loaded:/i, function () { return 'World loaded'; }],
		[/^HOSTING on UDP [^:]*:(\d+)/i, function (m) { return 'Hosting: players can join on port ' + m[1]; }],
		[/^exiting: the start was refused/i, function () { return 'The world file is from a different game version; the server held it back'; }]
	];
	function plainLine(l) {
		if (!l || typeof l.msg !== 'string') return l;
		if (l.source === 'waygate') {
			for (var i = 0; i < MILESTONES.length; i++) { var m = MILESTONES[i][0].exec(l.msg); if (m) return { seq: l.seq, ts: l.ts, source: 'waygate', level: 'Info', msg: MILESTONES[i][1](m) }; }
			if (!/^(warn|err|fatal)/i.test(l.level || '')) return null;
		}
		if (l.source === 'admin' && /unauthorized|refused/i.test(l.msg)) return l;
		if (MACHINE.test(l.msg)) return null;
		return l;
	}
	function conLine(l, mine, replay) {
		var out = $('wgconOut');
		if (mine && !replay) { conMine.push({ after: conSeq, l: l }); while (conMine.length > 200) conMine.shift(); }
		if (!mine) { l = plainLine(l); if (!l) return; }
		if (!mine && !wantSource(l.source)) return;
		var when = l.ts ? new Date(l.ts).toLocaleTimeString() : '';
		var cls = mine ? 'me' : (/^err/i.test(l.level || '') ? 'err' : (/^warn/i.test(l.level || '') ? 'warn' : ''));
		var div = document.createElement('div'); div.className = cls;
		div.innerHTML = (when ? '<span class="t">' + esc(when) + '</span> ' : '') + (l.source && !mine ? '<span class="src' + (l.source === 'chat' ? ' chat' : '') + '">' + esc(l.source) + '</span> ' : '') + esc(l.msg);
		out.appendChild(div);
		while (out.childNodes.length > 800) out.removeChild(out.firstChild);
		if ($('wgconFollow').checked) out.scrollTop = out.scrollHeight;
	}
	function bootConsole() {
		if (!unlocked) return;
		var out = $('wgconOut'); out.innerHTML = '';
		get('/api/v1/console/recent?limit=300', function (d) {
			if (!d || d.error) { out.innerHTML = '<div class="err">' + (d && d.unauthorized ? 'The password was not accepted. Lock and unlock again.' : 'Could not reach the console.') + '</div>'; return; }
			var lines = d.lines || [], m = 0;
			// the ring is the server's; the commands typed here and their answers live only in this
			// page, so a repaint (a filter change) puts them back where they were
			for (var i = 0; i < lines.length; i++) { while (m < conMine.length && conMine[m].after < lines[i].seq) conLine(conMine[m++].l, true, true); conSeq = Math.max(conSeq, lines[i].seq); conLine(lines[i], false); }
			while (m < conMine.length) conLine(conMine[m++].l, true, true);
			var div = document.createElement('div'); div.className = 'wgcon-divider'; div.textContent = 'live from here'; out.appendChild(div); out.scrollTop = out.scrollHeight;
			attachStream();
		});
	}
	function attachStream() {
		if (conStream || !window.EventSource || !key) return;
		var ts = Math.floor(Date.now() / 1000), path = '/api/v1/console/stream';
		try { conStream = new EventSource(path + '?since=' + conSeq + '&ts=' + ts + '&sig=' + signature('GET', path, '', ts)); } catch (e) { conStream = null; return; }
		$('wgconLive').textContent = 'live';
		conStream.addEventListener('console', function (ev) { var l = null; try { l = JSON.parse(ev.data); } catch (e) { return; } if (l.seq) conSeq = Math.max(conSeq, l.seq); conLine(l, false); });
		conStream.onerror = function () {
			// the browser would retry with the same (now used) signature; sign a fresh one instead
			detachStream('reconnecting…');
			if (!conRetry && unlocked) conRetry = setTimeout(function () { conRetry = null; if (unlocked && activeTab === 'console') attachStream(); }, 1500);
		};
	}
	function detachStream(note) { if (conStream) { conStream.close(); conStream = null; } $('wgconLive').textContent = note || ''; }
	function runCommand(cmd) {
		cmd = (cmd || '').trim(); if (!cmd) return;
		conHistory.push(cmd); conHistoryAt = conHistory.length;
		conLine({ ts: Date.now(), msg: '> ' + cmd, source: '' }, true);
		$('wgconInput').value = '';
		var lower = cmd.toLowerCase();
		if (/^(ban|kick|kill|shutdown|restart) /.test(lower) || lower === 'shutdown' || lower === 'restart') { if (!confirm('Run "' + cmd + '"?')) return; }
		post('/api/v1/console/exec', { cmd: cmd, by: 'web' }, function (d) {
			if (!d) { conLine({ ts: Date.now(), msg: 'No answer from the server.', level: 'error' }, true); return; }
			if (d.error) { conLine({ ts: Date.now(), msg: d.error, level: 'error' }, true); return; }
			if (d.output) { var rows = String(d.output).split('\n'); for (var i = 0; i < rows.length; i++) if (rows[i] !== '') conLine({ ts: 0, msg: rows[i], source: '' }, true); }
			if (map) map.refresh();
		}, 30000);
	}
	$('wgconSend').addEventListener('click', function () { runCommand($('wgconInput').value); });
	$('wgconInput').addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter') { ev.preventDefault(); runCommand(this.value); return; }
		if (ev.key === 'ArrowUp' && conHistory.length) { ev.preventDefault(); conHistoryAt = Math.max(0, conHistoryAt - 1); this.value = conHistory[conHistoryAt] || ''; }
		if (ev.key === 'ArrowDown' && conHistory.length) { ev.preventDefault(); conHistoryAt = Math.min(conHistory.length, conHistoryAt + 1); this.value = conHistory[conHistoryAt] || ''; }
	});
	var side = document.querySelectorAll('.wgcon-cmd');
	for (var sb = 0; sb < side.length; sb++) (function (b) { b.addEventListener('click', function () { var c = b.getAttribute('data-cmd'); if (c.slice(-1) === ' ') { $('wgconInput').value = c; $('wgconInput').focus(); } else runCommand(c); }); })(side[sb]);
	$('wgconSource').addEventListener('change', function () { detachStream(''); bootConsole(); });
	$('wgAlEvery').addEventListener('change', function () { /* saved with the card's Save */ });

	// ---- players tab ---------------------------------------------------------------------------------------
	function bootPlayers() {
		var host = $('wgPlList');
		var paint = function (rows) {
			if (!rows.length) { host.innerHTML = '<div class="wg-empty">Nobody is playing right now.</div>'; return; }
			host.innerHTML = '<div class="wg-tablewrap"><table class="wg-table"><thead><tr><th>Player</th><th>Level</th><th>Where</th><th>On for</th>' + (unlocked ? '<th></th>' : '') + '</tr></thead><tbody>' + rows.map(function (p) {
				return '<tr><td class="n">' + esc(p.name) + '</td><td>' + esc(p.level || '') + '</td><td>' + esc(p.area || '') + '</td><td>' + esc(p.session != null ? spanOf(p.session) : '') + '</td>' + (unlocked ? '<td><button type="button" class="wg-btn" data-kick="' + esc(p.name) + '">Remove</button> <button type="button" class="wg-btn danger" data-ban="' + esc(p.name) + '">Block</button></td>' : '') + '</tr>';
			}).join('') + '</tbody></table></div>';
		};
		if (unlocked) {
			get('/api/v1/roster', function (d) {
				if (!d || d.error) { host.innerHTML = '<div class="wg-empty">Could not read the roster.</div>'; return; }
				paint((d.players || []).map(function (p) { return { name: p.name, level: p.level, area: prettyScene(p.scene), session: p.session_seconds }; }));
			});
			loadBans();
		} else {
			get('/api/v1/players', function (d) {
				if (!d || d.error) { host.innerHTML = '<div class="wg-empty">' + (d && d.unauthorized ? 'The player list is private on this server.' : 'Could not read the player list.') + '</div>'; return; }
				var byName = {}; if (lastRail && lastRail.players) lastRail.players.forEach(function (p) { byName[p.name] = p; });
				paint((d.players || []).map(function (p) { var r = byName[p.name] || {}; return { name: p.name, level: r.level, area: r.area, session: p.connected_seconds }; }));
			});
		}
	}
	function prettyScene(s) { s = String(s || ''); s = s.replace(/Part([IVX]+)([a-e])?$/, ' Part $1$2').replace(/(?<=[a-z])(?=[A-Z])/g, ' '); return s.trim(); }
	$('wgPlList').addEventListener('click', function (ev) {
		var b = ev.target.closest('button[data-kick],button[data-ban]'); if (!b) return;
		var kick = b.hasAttribute('data-kick'), name = b.getAttribute(kick ? 'data-kick' : 'data-ban');
		if (!confirm(kick ? 'Remove ' + name + '?' : 'Block ' + name + '? They are removed and kept out until you unblock them.')) return;
		b.disabled = true;
		post(kick ? '/api/v1/players/kick' : '/api/v1/bans', { name: name, by: 'web' }, function (d) { b.disabled = false; if (!d || d.error) alert((d && d.error) || 'That did not go through.'); booted.players = false; activate('players'); if (map) map.refresh(); });
	});
	function loadBans() {
		get('/api/v1/bans', function (d) {
			var host = $('wgBanList');
			if (!d || d.error) { host.innerHTML = '<div class="wg-empty">Could not read the blocked list.</div>'; return; }
			var list = d.bans || [];
			if (!list.length) { host.innerHTML = '<div class="wg-empty">Nobody is blocked.</div>'; return; }
			host.innerHTML = '<div class="wg-tablewrap"><table class="wg-table"><thead><tr><th>Player</th><th>Why</th><th>Blocks</th><th></th></tr></thead><tbody>' + list.map(function (b) {
				return '<tr><td class="n">' + esc(b.name || 'Unknown') + '</td><td>' + esc(b.reason || '') + '</td><td>' + (b.ip_banned ? 'character and address' : 'character') + '</td><td><button type="button" class="wg-btn" data-unban="' + esc(b.id) + '">Unblock</button></td></tr>';
			}).join('') + '</tbody></table></div>';
		});
	}
	$('wgBanList').addEventListener('click', function (ev) {
		var b = ev.target.closest('button[data-unban]'); if (!b) return;
		b.disabled = true;
		post('/api/v1/bans/remove', { id: b.getAttribute('data-unban'), by: 'web' }, function (d) { b.disabled = false; result('wgBanResult', d, 'They can join again.'); loadBans(); });
	});

	// ---- alerts -----------------------------------------------------------------------------------------------
	function alPaint(d) {
		if (!d || d.error) return;
		$('wgAlWebhook').value = '';
		$('wgAlWebhook').placeholder = d.webhook === 'set' ? 'A Discord link is saved. Paste a new one to change it.' : 'https://discord.com/api/webhooks/...';
		$('wgAlJoin').checked = !!d.on_join; $('wgAlFull').checked = !!d.on_full; $('wgAlDeath').checked = !!d.on_death; $('wgAlLife').checked = !!d.on_lifecycle;
		$('wgAlEvery').value = String(d.roundup_hours || 0);
		if (d.last_error) { $('wgAlResult').className = 'wg-result bad'; $('wgAlResult').textContent = 'Last problem: ' + d.last_error; }
	}
	function bootAlerts() { if (!unlocked) return; get('/api/v1/alerts', alPaint); }
	$('wgAlSave').addEventListener('click', function () {
		var typed = $('wgAlWebhook').value.trim(), self = this; self.disabled = true;
		post('/api/v1/alerts', { webhook: typed === '' ? '__keep__' : typed, on_join: $('wgAlJoin').checked ? '1' : '0', on_full: $('wgAlFull').checked ? '1' : '0', on_death: $('wgAlDeath').checked ? '1' : '0', on_lifecycle: $('wgAlLife').checked ? '1' : '0', roundup_hours: $('wgAlEvery').value, by: 'web' }, function (d) {
			self.disabled = false; result('wgAlResult', d, d && d.result ? d.result.charAt(0).toUpperCase() + d.result.slice(1) + '.' : 'Saved.'); if (d && !d.error) get('/api/v1/alerts', alPaint);
		});
	});
	$('wgAlTest').addEventListener('click', function () {
		var self = this; self.disabled = true; $('wgAlResult').className = 'wg-result'; $('wgAlResult').textContent = 'Sending…';
		post('/api/v1/alerts/test', { by: 'web' }, function (d) { self.disabled = false; result('wgAlResult', d, 'Sent. Check your Discord channel.'); });
	});

	// ---- tabs ----------------------------------------------------------------------------------------------------
	var booted = {}, activeTab = 'map';
	function activate(name) {
		activeTab = name;
		var tabs = document.querySelectorAll('.wg-tab'); for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
		var panes = document.querySelectorAll('.wg-pane'); for (var j = 0; j < panes.length; j++) panes[j].classList.toggle('active', panes[j].getAttribute('data-pane') === name);
		if (name === 'map' && map) map.resize();
		if (name !== 'console') detachStream('');
		if (booted[name]) { if (name === 'console' && unlocked) attachStream(); return; }
		booted[name] = true;
		if (name === 'console') bootConsole();
		if (name === 'players') bootPlayers();
		if (name === 'alerts') bootAlerts();
	}
	var tabButtons = document.querySelectorAll('.wg-tab');
	for (var tb = 0; tb < tabButtons.length; tb++) (function (b) { b.addEventListener('click', function () { activate(b.getAttribute('data-tab')); }); })(tabButtons[tb]);

	// ---- boot --------------------------------------------------------------------------------------------------------
	loadInfo(); setInterval(loadInfo, 15000);
	bootMap();
	if (password) { get('/api/v1/status', function (d) { unlocked = !!(d && !d.unauthorized && !d.error); if (!unlocked) setPassword(null); paintLock(); }); } else paintLock();
	window.wgApp = { activate: activate, unlocked: function () { return unlocked; }, sign: signature };
})();
