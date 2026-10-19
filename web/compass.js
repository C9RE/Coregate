/* Coregate map: the live world map for a Dimraeth server.
 *
 * One renderer for three surfaces: the server's own web page (served by the admin
 * plugin), the SurvivalServers panel tool and its public share page. The surface
 * gives it a root element, where the map files live, a poll function that returns
 * the live feed, and a callback for the live roster; this file draws everything and
 * never talks to a game server itself.
 *
 * Base layer: the game's own map pictures (one per scene), composited per area by
 * the scene rectangles the running game reports, at the game's four pixels per
 * world unit, as a pyramid (0.25, 0.5 and 1 px/unit sheets, 2 and 4 px/unit tiles).
 * The level drawn is always the smallest one at or above the screen density, so the
 * picture is never stretched below its own pixels. The game filters these textures
 * point-sampled and zooms them up to 4x, so above native the tiles are drawn
 * nearest-neighbour at whole multiples (crisp pixel blocks, like the game's own map),
 * and the zoom stops where the game's does. Projection: every area is a plain
 * rectangle in world units, y up.
 */
(function () {
	'use strict';

	var MARKER_CELLS = ['player', 'waygate', 'waystone', 'crystal', 'camp', 'cave', 'ruin', 'grove', 'shop', 'forge', 'farmstead', 'den', 'boss', 'building', 'farm', 'ghost'];
	// the second sheet: the live layers' marks (quests, bosses, chests, people and places, progress)
	var MARKER_CELLS2 = ['quest', 'quest_own', 'boss_fight', 'boss_beaten', 'chest', 'chest_open', 'chest_player', 'npc', 'merchant', 'board', 'bridge', 'cards', 'progress', 'followers', 'tombstone', 'ore'];
	var CELL = 96;
	var LAYER_DEFS = [
		{ key: 'players',   label: 'Adventurers',          icon: 'player',   on: true,  live: true },
		{ key: 'offline',   label: 'Last seen',            icon: 'ghost',    on: true,  live: true },
		{ key: 'waygate',   label: 'Waygates',             icon: 'waygate',  on: true },
		{ key: 'waystone',  label: 'Waystones',            icon: 'waystone', on: true },
		{ key: 'crystal',   label: 'Map crystals',         icon: 'crystal',  on: true },
		{ key: 'sites',     label: 'Ruins, groves, caves', icon: 'ruin',     on: true },
		{ key: 'village',   label: 'Shops and farms',      icon: 'shop',     on: true },
		{ key: 'camp',      label: 'Camps',                icon: 'camp',     on: false },
		{ key: 'passage',   label: 'Area passages',        icon: 'cave',     on: false },
		{ key: 'sanctum',   label: 'Sanctum buildings',    icon: 'building', on: true, live: true },
		{ key: 'portal',    label: 'Player portals',       icon: 'waystone', on: true, live: true },
		// live layers: drawn from the feed's "layers" block; a row shows only when the feed carries its data
		// (an older host, or a link whose owner left the layer unticked, simply has no row)
		{ key: 'quests',    label: 'Quests',               icon: 'quest',    on: true, live: true, data: 'quests' },
		{ key: 'bosses',    label: 'Bosses',               icon: 'boss',     on: true, live: true, data: 'bosses', modes: [['met', 'Bosses this world has met'], ['all', 'Every lair (spoilers)']] },
		{ key: 'chests',    label: 'Chests',               icon: 'chest',    on: true, live: true, data: 'chests', modes: [['found', 'Opened chests and players\' storage'], ['all', 'Every loot chest (spoilers)']] },
		{ key: 'people',    label: 'People and places',    icon: 'npc',      on: true, live: true, data: 'pois' },
		{ key: 'progress',  label: 'World progress',       icon: 'progress', on: true, live: true, data: 'progress' },
		{ key: 'names',     label: 'Names on the map',     icon: null,       on: true },
		{ key: 'fog',       label: 'Fog of war',           icon: null,       on: false, note: 'Hide what your players have not discovered yet' }
	];
	var LEGEND = [['waygate', 'Waygate'], ['waystone', 'Waystone'], ['crystal', 'Crystal'], ['cave', 'Cave'], ['player', 'Player']];
	var SITE_KINDS = { ruin: 1, grove: 1, cave: 1, den: 1 };
	var VILLAGE_KINDS = { shop: 1, forge: 1, farmstead: 1 };
	// decoded tiles kept: a byte budget (a 512 px tile is 1 MB decoded), smaller on a phone; a zoom
	// in and out again over every level of a 1920x1080 view touches about 120 tiles
	var TILE_BUDGET_BYTES = ((navigator.deviceMemory && navigator.deviceMemory <= 4) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) ? 72e6 : 200e6;
	var ZOOM_MS = 120;   // the eased glide between two zoom steps (the sharp frame lands one frame after it)

	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
	function hue(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return h % 360; }
	function span(sec) { sec = Math.max(0, Math.round(sec)); if (sec < 90) return sec + ' s'; if (sec < 5400) return Math.round(sec / 60) + ' min'; if (sec < 172800) return Math.round(sec / 3600) + ' h'; return Math.round(sec / 86400) + ' d'; }
	// a swatch from either marker sheet, for the layers menu and the progress card
	function cellHtml(icon) { var i = MARKER_CELLS.indexOf(icon); if (i >= 0) return '<span class="wgc-cell" style="background-position:' + (-i * 22) + 'px 0"></span>'; i = MARKER_CELLS2.indexOf(icon); if (i >= 0) return '<span class="wgc-cell wgc-cell2" style="background-position:' + (-i * 22) + 'px 0"></span>'; return ''; }
	function ago(sec) { if (sec < 60) return 'just now'; if (sec < 3600) return Math.round(sec / 60) + ' min ago'; if (sec < 86400) return Math.round(sec / 3600) + ' h ago'; return Math.round(sec / 86400) + ' d ago'; }

	function mount(opts) {
		var root = opts.root;
		var mode = opts.mode || 'panel';
		var show = opts.show || {};
		if (show.positions == null) show.positions = true;
		if (show.health == null) show.health = (mode !== 'share');
		if (show.names == null) show.names = true;
		if (show.offline == null) show.offline = (mode !== 'share');
		var pollMs = opts.pollMs || 5000;
		var assets = opts.assets || '';
		var artBase = '';   // catalog.art_base when the pyramid is served from elsewhere (a CDN, CORS on), else the page's own assets
		function crossOrigin(url) { return /^https?:\/\//.test(url) && url.indexOf(location.origin + '/') !== 0; }

		// ---- DOM: the map fills the root; everything else floats over it ----------------
		root.innerHTML = '';
		var wrap = el('div', 'wgc wgc-' + mode);
		var canvas = el('canvas', 'wgc-map');
		var areas = el('div', 'wgc-areas'); areas.setAttribute('role', 'tablist');
		var zoom = el('div', 'wgc-zoom', '<button type="button" data-z="in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out" title="Zoom out">&minus;</button><button type="button" data-z="fit" aria-label="Fit the whole area" title="Fit the whole area">&#8982;</button><button type="button" data-z="layers" aria-label="Layers" title="Layers" class="wgc-layersbtn">&#9776;</button>');
		var layersEl = el('div', 'wgc-layers'); layersEl.style.display = 'none';
		var legend = el('div', 'wgc-legend');
		var scaleEl = el('div', 'wgc-scale', '<span class="wgc-scale-label">&ndash;</span><div class="wgc-scale-bar"></div>');
		var noteEl = el('div', 'wgc-note');
		var emptyEl = el('div', 'wgc-empty');
		var badge = el('div', 'wgc-badge');
		var tipEl = el('div', 'wgc-tip', '<b></b><span></span>');
		var progEl = el('div', 'wgc-progress'); progEl.style.display = 'none';
		wrap.appendChild(canvas); wrap.appendChild(areas); wrap.appendChild(badge); wrap.appendChild(zoom); wrap.appendChild(layersEl); wrap.appendChild(legend); wrap.appendChild(scaleEl); wrap.appendChild(noteEl); wrap.appendChild(progEl); wrap.appendChild(tipEl); wrap.appendChild(emptyEl);
		root.appendChild(wrap);
		var ctx = canvas.getContext('2d');
		legend.innerHTML = LEGEND.map(function (l) { return '<span class="wgc-legend-item"><span class="wgc-cell" style="background-position:' + (-MARKER_CELLS.indexOf(l[0]) * 22) + 'px 0"></span>' + l[1] + '</span>'; }).join('');

		// ---- state ------------------------------------------------------------------------
		var catalog = null, maps = {}, order = [], current = null, userTab = false;
		var art = {}, tiles = {}, tileOrder = [], regionsImg = {}, fogCache = {}, markers = null, drawnLevel = null;
		var live = null, liveAt = 0, running = null, lastStatus = null, everLive = false, timer = null, inflight = false, noFeedPolls = 0;
		var layerOn = {}, layerMode = {}; LAYER_DEFS.forEach(function (L) { layerOn[L.key] = L.on; if (L.modes) layerMode[L.key] = L.modes[0][0]; });
		var markers2 = null, hits = [], hot = null, tipTimer = null, progOpen = false, drawnLayers = {};
		// what this viewer switched on or off is theirs and is remembered on this device, per surface
		// (the owner's tool, a share link, the server's own page). The fog a link's owner asked for is not a preference.
		var PREF_KEY = 'wgcLayers.' + mode;
		(function () { try { var p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); if (!p) return; LAYER_DEFS.forEach(function (L) { if (p.on && typeof p.on[L.key] === 'boolean' && L.key !== 'fog') layerOn[L.key] = p.on[L.key]; if (L.modes && p.modes && p.modes[L.key]) L.modes.forEach(function (m) { if (m[0] === p.modes[L.key]) layerMode[L.key] = m[0]; }); }); if (p.on && typeof p.on.fog === 'boolean' && opts.fog !== 'world') layerOn.fog = p.on.fog; if (p.progOpen) progOpen = true; } catch (e) { /* no storage: the defaults stand */ } })();
		function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ on: layerOn, modes: layerMode, progOpen: progOpen })); } catch (e) { /* no storage */ } }
		// fog of war: opts.fog = 'off' | 'world' (a share link, the server's own page); the owner's tool starts off.
		// fogPlayer = '' shows what anyone has discovered; a name shows only that adventurer's discoveries
		var fogPlayer = ''; if (opts.fog === 'world') layerOn.fog = true;
		var fogImgs = {};
		if (!show.offline) layerOn.offline = false;
		var view = { cx: 0, cy: 0, scale: 0, user: false };
		var dpr = 1, dragging = null, touch = null, layersOpen = false;
		var useClock = 0, frameClock = 0, drawQueued = false, anim = null, held = {}, wantedLevel = null, levelIsReady = false, lastPointer = null, prefetchTimer = null;
		var lastBar = '', fetchQueue = [], fetchPumping = false;
		var perf = { viewAt: 0, sharpAt: 0, draws: 0 };   // for the zoom measurement: when the view last changed, when it was next whole
		var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		var INSET = { top: 52, right: 14, bottom: 44, left: 14 }, FIT_PAD = 0.03;

		function setBadge(cls, html) {
			badge.className = 'wgc-badge wgc-badge-' + cls + (html ? '' : ' wgc-badge-hidden');
			badge.innerHTML = html || '';
			if (opts.onStatus) opts.onStatus({ cls: cls, text: badge.textContent, players: live && live.players ? live.players.length : 0, running: running, live: live });
		}
		function setEmpty(html) { emptyEl.innerHTML = html || ''; emptyEl.style.display = html ? 'flex' : 'none'; }

		// ---- assets ---------------------------------------------------------------------------
		function loadCatalog() {
			var x = new XMLHttpRequest();
			x.open('GET', opts.catalogUrl, true);
			x.onload = function () {
				if (x.status !== 200) { setEmpty('The map data could not be loaded.'); return; }
				try { catalog = JSON.parse(x.responseText); } catch (e) { setEmpty('The map data is unreadable.'); return; }
				artBase = catalog.art_base || assets;
				catalog.maps.forEach(function (m) {
					m.spanX = m.top_right[0] - m.bottom_left[0]; m.spanY = m.top_right[1] - m.bottom_left[1];
					if (m.sheet) m.fogWorld = { x0: m.sheet.origin[0], y1: m.sheet.origin[1], x1: m.sheet.origin[0] + m.sheet.w / m.sheet.px_per_unit, y0: m.sheet.origin[1] - m.sheet.h / m.sheet.px_per_unit };
					m.regionById = {}; (m.regions || []).forEach(function (r) { m.regionById[r.id] = r; });
					m.sceneSet = {}; (m.scenes || []).forEach(function (s) { m.sceneSet[s.scene] = s; });
					if (m.art && m.art.levels) { m.art.levels.sort(function (a, b) { return a.ppu - b.ppu; }); m.art.levels.forEach(function (L) { if (L.tiles) { L.tiles.presentSet = {}; (L.tiles.present || []).forEach(function (p) { L.tiles.presentSet[p[0] + ':' + p[1]] = 1; }); } }); }
					maps[m.key] = m; order.push(m.key);
				});
				renderAreas();
				selectMap(order.indexOf('earlwood') >= 0 ? 'earlwood' : order[0], false);
				renderLayers();
			};
			x.onerror = function () { setEmpty('The map data could not be loaded.'); };
			x.send();
			if (opts.markersUrl) { var mk = new Image(); mk.onload = function () { markers = mk; requestDraw(); }; mk.src = opts.markersUrl; }
			if (opts.markers2Url) { var mk2 = new Image(); mk2.onload = function () { markers2 = mk2; requestDraw(); }; mk2.src = opts.markers2Url; }
		}
		// the whole-sheet levels load once per area; a level that fails marks the art missing
		function ensureArt(key) {
			if (art[key]) return;
			var m = maps[key]; art[key] = { sheets: {}, missing: false };
			if (!m.art || !m.art.levels) { art[key].missing = true; return; }
			m.art.levels.forEach(function (L) {
				if (!L.file) return;
				var sheetFailed = function () { if (!Object.keys(art[key].sheets).length) art[key].missing = true; requestDraw(); };
				if (window.fetch && window.createImageBitmap) {
					fetch(artBase + L.file, { mode: 'cors', credentials: 'same-origin' }).then(function (res) { if (!res.ok) throw new Error('sheet ' + res.status); return res.blob(); }).then(function (blob) { return createImageBitmap(blob); })
						.then(function (b) { art[key].sheets[L.ppu] = b; requestDraw(); }, sheetFailed);
					return;
				}
				var img = new Image();
				img.decoding = 'async'; if (crossOrigin(artBase)) img.crossOrigin = 'anonymous';
				img.onload = function () { var ok = function () { art[key].sheets[L.ppu] = img; requestDraw(); }; if (img.decode) img.decode().then(ok, ok); else ok(); };
				img.onerror = sheetFailed;
				img.src = artBase + L.file;
			});
			if (m.regions && m.regions.length && m.sheet) { var rg = new Image(); rg.onload = function () { regionsImg[key] = rg; fogCache = {}; requestDraw(); }; rg.src = assets + 'regions-' + key + '-' + catalog.build + '.png'; }
		}
		// A tile is ready only once it is DECODED (createImageBitmap, off the main thread), so drawing
		// it never stalls a frame. peek = look in the cache without asking the network; low = a
		// prefetch, behind what the view needs now. Every use stamps the tile; the least recently
		// used go first when the byte budget is full, never one the current frame drew.
		function tile(key, L, c, r, peek, low) {
			if (!L.tiles.presentSet[c + ':' + r]) return null;
			var id = key + '/' + L.ppu + '/' + c + '_' + r; var t = tiles[id];
			if (t) { t.used = ++useClock; if (!low && !peek) t.low = false; return t.ok ? (t.bmp || t.img) : null; }
			if (peek) return null;
			t = { img: null, bmp: null, ok: false, low: !!low, ctl: null, used: ++useClock, level: L.ppu }; tiles[id] = t; tileOrder.push(id);
			var url = artBase + L.tiles.path + c + '_' + r + '.webp';
			// a tile that lands while the view is already whole is a fetch ahead: it needs no frame
			var ready = function () { t.ok = true; t.ctl = null; if (!levelIsReady || moving()) requestDraw(); };
			var failed = function (e) { t.ctl = null; if (e && e.name === 'AbortError') { if (tiles[id] === t) { delete tiles[id]; var k = tileOrder.indexOf(id); if (k >= 0) tileOrder.splice(k, 1); } return; } t.failed = true; requestDraw(); };
			var mode = ''; try { mode = localStorage.getItem('wgcTileMode') || ''; } catch (e) { /* no storage */ }
			if (mode !== 'img' && window.fetch && window.createImageBitmap) {
				// the bytes as a blob, decoded by createImageBitmap on a worker thread: measured, an <img>
				// handed to createImageBitmap still decoded on the main thread (72 of 76 decodes)
				t.ctl = window.AbortController ? new AbortController() : null;
				t.go = function () {
					t.go = null; if (tiles[id] !== t) return;
					var init = { mode: 'cors', credentials: 'same-origin' }; if (t.ctl) init.signal = t.ctl.signal; if (t.low) init.priority = 'low';
					fetch(url, init).then(function (res) { if (!res.ok) throw new Error('tile ' + res.status); return res.blob(); }).then(function (blob) { return createImageBitmap(blob); })
						.then(function (b) { if (tiles[id] === t) { t.bmp = b; warm(b); ready(); } else if (b.close) b.close(); }, failed);
				};
				fetchQueue.push(t); pumpFetches();
			} else {
				var img = new Image(); t.img = img; img.decoding = 'async'; if (crossOrigin(artBase)) img.crossOrigin = 'anonymous'; if (low && 'fetchPriority' in img) img.fetchPriority = 'low';
				img.onload = function () { if (img.decode) img.decode().then(ready, ready); else ready(); };
				img.onerror = function () { failed(null); };
				img.src = url;
			}
			trimTiles();
			return null;
		}
		var warmCanvas = null, warmCtx = null, warmOn = null;
		function warm(b) {
			if (warmOn === null) { warmOn = true; try { if (localStorage.getItem('wgcWarm') === '0') warmOn = false; } catch (e) { /* no storage */ } }
			if (!warmOn) return;
			if (!warmCanvas) { warmCanvas = document.createElement('canvas'); warmCanvas.width = 512; warmCanvas.height = 512; warmCtx = warmCanvas.getContext('2d'); }
			try { warmCtx.drawImage(b, 0, 0); } catch (e) { /* a closed bitmap */ }
		}
		// requests leave a few per frame, what the view needs before what is fetched ahead
		function pumpFetches() {
			if (fetchPumping) return; fetchPumping = true;
			var step = function () {
				fetchQueue.sort(function (a, b) { return (a.low ? 1 : 0) - (b.low ? 1 : 0); });
				for (var k = 0; k < 6 && fetchQueue.length; k++) { var t = fetchQueue.shift(); if (t.go) t.go(); else k--; }
				if (fetchQueue.length) requestAnimationFrame(step); else fetchPumping = false;
			};
			step();
		}
		// a new zoom step: the fetches ahead that are still in flight for OTHER levels give their
		// bandwidth back to the tiles the step needs (they are asked for again when the view rests)
		function dropStalePrefetch(keepPpu) {
			for (var id in tiles) { var t = tiles[id]; if (!t.low || t.ok || t.level === keepPpu) continue; if (t.go) { t.go = null; delete tiles[id]; var k = tileOrder.indexOf(id); if (k >= 0) tileOrder.splice(k, 1); } else if (t.ctl) { try { t.ctl.abort(); } catch (e) { /* already settled */ } } }
		}
		function trimTiles() {
			var max = Math.max(48, Math.floor(TILE_BUDGET_BYTES / (512 * 512 * 4)));
			if (tileOrder.length <= max) return;
			tileOrder.sort(function (a, b) { return tiles[a].used - tiles[b].used; });
			while (tileOrder.length > max && tiles[tileOrder[0]].used < frameClock) { var old = tileOrder.shift(); var o = tiles[old]; if (o && o.bmp && o.bmp.close) o.bmp.close(); delete tiles[old]; }
		}
		// the tile columns and rows of level L that a view (centre, scale) shows
		function tileRange(m, L, cx, cy, s) {
			var T = L.tiles, w = canvas.width / dpr, h = canvas.height / dpr, upt = T.size / L.ppu, bl = m.bottom_left, tr = m.top_right;
			return { c0: Math.max(0, Math.floor((cx - w / 2 / s - bl[0]) / upt)), c1: Math.min(T.cols - 1, Math.floor((cx + w / 2 / s - bl[0]) / upt)),
				r0: Math.max(0, Math.floor((tr[1] - (cy + h / 2 / s)) / upt)), r1: Math.min(T.rows - 1, Math.floor((tr[1] - (cy - h / 2 / s)) / upt)) };
		}
		// is everything level L needs for that view decoded? load = ask for what is missing
		function levelReady(key, m, L, cx, cy, s, load, low) {
			if (L.file) return !!(art[key] && art[key].sheets[L.ppu]);
			var q = tileRange(m, L, cx, cy, s), all = true;
			for (var r = q.r0; r <= q.r1; r++) for (var c = q.c0; c <= q.c1; c++) {
				if (!L.tiles.presentSet[c + ':' + r]) continue;
				var t = tiles[key + '/' + L.ppu + '/' + c + '_' + r];
				if (t && t.failed) continue;
				if (!tile(key, L, c, r, !load, low)) all = false;
			}
			return all;
		}
		// The source's own facts, from the catalog, so a new picture source (another density,
		// another ceiling, a bilinear source) changes nothing here: the native density (px per
		// unit), the zoom ceiling over it, and whether the source is point-sampled (drawn as
		// pixel blocks above native) or filtered (drawn smoothed above native).
		function nativePpu(m) { return (m.art && m.art.px_per_unit) || 4; }
		function maxOverNative(m) { return (m.art && m.art.max_zoom_over_native) || 4; }
		function pointSampled(m) { return !(m.art && m.art.filter && m.art.filter !== 'point'); }
		// screen density in DEVICE pixels per world unit: the level choice and the
		// nearest-neighbour blocks both work in device pixels
		function devScale() { return view.scale * dpr; }
		// the smallest level at or above the screen density, so nothing is stretched; above
		// native there is nothing bigger and the native tiles are drawn as pixel blocks
		function pickLevel(m, ds) {
			var Ls = m.art.levels, best = null;
			for (var i = 0; i < Ls.length; i++) { if (Ls[i].ppu >= ds - 1e-6) { best = Ls[i]; break; } }
			return best || Ls[Ls.length - 1];
		}

		// ---- areas ------------------------------------------------------------------------------
		function renderAreas() {
			areas.innerHTML = '';
			order.forEach(function (key) {
				var m = maps[key];
				var b = el('button', 'wgc-area' + (key === current ? ' active' : ''), '<span>' + esc(m.label) + '</span><em class="wgc-area-count" data-map="' + esc(key) + '"></em>');
				b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('data-map', key);
				b.addEventListener('click', function () { selectMap(key, true); });
				areas.appendChild(b);
			});
			updateAreaCounts();
		}
		function updateAreaCounts() {
			var counts = {};
			if (live && live.players) live.players.forEach(function (p) { var k = mapOfScene(p.scene); if (k) counts[k] = (counts[k] || 0) + 1; });
			var ems = areas.querySelectorAll('.wgc-area-count');
			for (var i = 0; i < ems.length; i++) { var k = ems[i].getAttribute('data-map'); ems[i].textContent = counts[k] ? counts[k] : ''; }
		}
		function mapOfScene(scene) {
			if (!scene || !catalog) return null;
			if (catalog.indoor && catalog.indoor[scene]) { var im = catalog.indoor[scene].map; for (var k in maps) if (maps[k].game_name === im) return k; }
			for (var key in maps) if (maps[key].sceneSet[scene]) return key;
			return null;
		}
		function selectMap(key, byUser) {
			if (!maps[key]) return;
			current = key; if (byUser) userTab = true;
			ensureArt(key);
			var bs = areas.querySelectorAll('.wgc-area');
			for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('active', bs[i].getAttribute('data-map') === key);
			var act = areas.querySelector('.wgc-area.active'); if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
			view.user = false; fitView(); renderLayers(); draw();
			if (opts.onArea) opts.onArea(key);
		}

		// ---- live ----------------------------------------------------------------------------------
		function fetchLive() {
			if (inflight) return; inflight = true;
			opts.poll(function (r) {
				inflight = false;
				if (!r) { setBadge('err', 'Connection lost'); live = null; emit(); requestDraw(); return; }
				if (r.running === false) { running = false; live = null; setBadge('off', 'Server offline'); emit(); requestDraw(); return; }
				running = true; lastStatus = r.status || null;
				if (!r.map) {
					live = null; noFeedPolls++;
					var tooOld = !!(lastStatus && lastStatus.verdict === 'HOSTING' && lastStatus.map_feed !== true && mode === 'panel');
					if (tooOld) { setBadge('off', 'Host needs an update'); setEmpty('This server is running an older Coregate host that has no map. Restart the server, then reopen the map.'); emit(); draw(); return; }
					if (lastStatus && lastStatus.verdict && lastStatus.verdict !== 'HOSTING') { setBadge('off', esc(lastStatus.verdict.toLowerCase().replace(/_/g, ' '))); emit(); draw(); return; }
					if (noFeedPolls >= 8) { setBadge('err', 'No map from the host'); setEmpty('The server is running but is not answering with a map. Restart it; if that does not help, ask for help.'); emit(); draw(); return; }
					setBadge('off', 'Waking the map&hellip;'); emit(); requestDraw(); return;
				}
				noFeedPolls = 0; setEmpty('');
				live = r.map; liveAt = Date.now(); everLive = true;
				var n = live.players ? live.players.length : 0;
				var stale = (live.age != null && live.age > 40);
				setBadge(stale ? 'off' : 'live', (stale ? 'Last seen ' + ago(live.age) : '<i class="wgc-dot"></i> Live') + ' &middot; ' + n + (n === 1 ? ' adventurer' : ' adventurers'));
				if (!userTab && n > 0) { var best = null, bestN = 0, counts = {}; live.players.forEach(function (p) { var k = mapOfScene(p.scene); if (!k) return; counts[k] = (counts[k] || 0) + 1; if (counts[k] > bestN) { bestN = counts[k]; best = k; } }); if (best && best !== current) selectMap(best, false); }
				updateAreaCounts(); renderLayers(); paintProgress(); emit(); requestDraw();
			});
		}
		function emit() {
			paintProgress();
			if (!opts.onLive) return;
			var ps = (live && live.players) ? live.players.map(function (p) {
				var k = mapOfScene(p.scene); var m = k ? maps[k] : null;
				return { name: p.name, level: p.level, hp: p.hp, hp_max: p.hp_max, dead: !!p.dead, sleeping: !!p.sleeping, teleporting: !!p.teleporting, map: k, area: m ? (m.sceneSet[p.scene] ? m.sceneSet[p.scene].label : m.label) : (p.scene || ''), color: 'hsl(' + hue(p.name || '') + ',60%,55%)' };
			}) : [];
			opts.onLive({ running: running, live: !!live, players: ps, offline: live ? (live.offline || []) : [], bosses: live ? (live.bosses || []) : [], current: current, everLive: everLive });
		}
		function exploredSet() {
			var s = {};
			if (live && live.world && live.world.explored) live.world.explored.forEach(function (r) { s[r] = 1; });
			if (live && live.players) live.players.forEach(function (p) { (p.regions || []).forEach(function (r) { s[r] = 1; }); });
			return s;
		}
		// the ground the fog leaves open: everything anyone found, or one adventurer's own finds (plus the
		// world's shared finds when the server shares crystals)
		function discoveredSet() {
			if (!fogPlayer) return exploredSet();
			var s = {};
			if (live && live.world && live.world.share_regions && live.world.explored) live.world.explored.forEach(function (r) { s[r] = 1; });
			var everyone = (live && live.players ? live.players : []).concat(live && live.offline ? live.offline : []);
			everyone.forEach(function (p) { if (p.name === fogPlayer) (p.regions || []).forEach(function (r) { s[r] = 1; }); });
			return s;
		}
		function fogPiece(m, f) {
			var id = current + '/' + f.id, t = fogImgs[id];
			if (t) return t.bmp;
			t = fogImgs[id] = { bmp: null };
			var url = assets + f.file;
			var done = function (b) { t.bmp = b; try { var mc = document.createElement('canvas'); mc.width = 64; mc.height = 64; var mx = mc.getContext('2d'); mx.drawImage(b, 0, 0, 64, 64); t.mask = mx.getImageData(0, 0, 64, 64).data; } catch (e) { t.mask = null; } requestDraw(); };
			if (window.fetch && window.createImageBitmap) fetch(url, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('fog ' + r.status); return r.blob(); }).then(function (b) { return createImageBitmap(b); }).then(done, function () { t.bmp = null; });
			else { var img = new Image(); img.onload = function () { done(img); }; img.src = url; }
			return null;
		}
		// the fog on screen: the game's own soft cut-out for every undiscovered region that has one, and the
		// region-index veil under the rest; returns how many regions are hidden
		function drawFog(m, s) {
			if (!layerOn.fog) return 0;
			var ex = discoveredSet(), hidden = 0, withPiece = {}; fogDrawnSet = ex; fogMarkersHidden = 0;
			(m.fog || []).forEach(function (f) { if (ex[f.id]) return; withPiece[f.id] = 1; hidden++; var b = fogPiece(m, f); if (!b) return; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; ctx.drawImage(b, sx(f.x0), sy(f.y1), (f.x1 - f.x0) * s, (f.y1 - f.y0) * s); });
			(m.regions || []).forEach(function (r) { if (!ex[r.id] && !withPiece[r.id]) hidden++; });
			fogHidden = hidden; fogNoPiece = withPiece;
			return hidden;
		}
		var fogHidden = 0, fogNoPiece = {}, fogMarkersHidden = 0;
		// is a world point under fog on screen? (a marker there would tell what the fog is meant to keep)
		function underFog(m, wx, wy) {
			if (!layerOn.fog) return false;
			var ex = fogDrawnSet;
			var fs = m.fog || [];
			for (var i = 0; i < fs.length; i++) {
				var f = fs[i]; if (ex[f.id] || wx < f.x0 || wx > f.x1 || wy < f.y0 || wy > f.y1) continue;
				var t = fogImgs[current + '/' + f.id]; if (!t || !t.mask) return true;
				var u = Math.min(63, Math.floor((wx - f.x0) / (f.x1 - f.x0) * 64)), v = Math.min(63, Math.floor((f.y1 - wy) / (f.y1 - f.y0) * 64));
				if (t.mask[(v * 64 + u) * 4 + 3] > 96) return true;
			}
			return false;
		}
		var fogDrawnSet = {};
		// an area's name stays off while none of its regions is discovered (a scene's centre can sit between the clouds)
		function sceneUnderFog(m, scene) {
			if (!layerOn.fog) return false;
			var rs = (m.regions || []).filter(function (r) { return r.scene === scene; }); if (!rs.length) return false;
			for (var i = 0; i < rs.length; i++) if (fogDrawnSet[rs[i].id]) return false;
			fogMarkersHidden++; return true;
		}
		function playerPoint(p) {
			if (catalog.indoor && catalog.indoor[p.scene]) return { x: catalog.indoor[p.scene].x, y: catalog.indoor[p.scene].y };
			return { x: p.x, y: p.y };
		}

		// ---- the live layers' data, as this viewer asked to see it ------------------------------------------
		function layerData(key) { var v = live && live.layers ? live.layers[key] : undefined; return (v === undefined || v === null) ? null : v; }
		function placeOf(scene, x, y) { if (catalog.indoor && catalog.indoor[scene]) return { x: catalog.indoor[scene].x, y: catalog.indoor[scene].y }; return { x: x, y: y }; }
		// a row the game keeps under one area but places somewhere else (an event's copy of a chest for another
		// telling of the map) would float over empty sea: a mark belongs on the map only inside its own area's ground
		function onOwnGround(scene, x, y) { if (x == null || y == null) return false; if (catalog.indoor && catalog.indoor[scene]) return true; var m = maps[current], sc = m && m.sceneSet[scene]; if (!sc || !sc.rect) return true; var r = sc.rect, pad = 24; return x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad; }
		function bossRows() { return (layerData('bosses') || []).filter(function (b) { if (mapOfScene(b.scene) !== current || !onOwnGround(b.scene, b.x != null ? b.x : b.lair_x, b.y != null ? b.y : b.lair_y)) return false; return layerMode.bosses === 'all' || b.state !== 'waiting'; }); }
		function chestRows() { return (layerData('chests') || []).filter(function (c) { if (mapOfScene(c.scene) !== current || !onOwnGround(c.scene, c.x, c.y)) return false; return layerMode.chests === 'all' || c.kind !== 'loot' || c.opened; }); }
		function poiRows() { return (layerData('pois') || []).filter(function (p) { return mapOfScene(p.scene) === current && onOwnGround(p.scene, p.x, p.y); }); }
		// a quest is on the map where its current step takes place: one spot per task that has a place
		function questSpots() { var out = []; (layerData('quests') || []).forEach(function (q) { (q.tasks || []).forEach(function (t) { if (t.x == null || t.y == null || mapOfScene(t.scene) !== current || !onOwnGround(t.scene, t.x, t.y)) return; out.push({ q: q, t: t }); }); }); return out; }
		function bossLine(b) {
			if (b.state === 'fight') return 'In a fight' + (b.hp_max > 0 ? ' \u00b7 ' + Math.max(0, Math.round(b.hp)) + ' / ' + Math.round(b.hp_max) : '');
			if (b.state === 'alive') return 'Awake' + (b.level ? ' \u00b7 level ' + b.level : '');
			if (b.state === 'down') return 'Down' + (b.respawn > 0 ? ' \u00b7 back in ' + span(b.respawn) : '');
			if (b.state === 'beaten') return 'Beaten on this world';
			return 'Not woken yet';
		}
		function chestLine(c) {
			if (c.kind === 'loot') return c.opened ? ('Opened' + (c.refill > 0 ? ' \u00b7 refills in ' + span(c.refill) : '')) : 'Not opened yet';
			var bits = []; if (c.owner) bits.push(c.owner + '\u2019s'); bits.push(c.empty ? 'empty' : (c.items != null ? c.items + (c.items === 1 ? ' stack' : ' stacks') : 'storage')); if (c.public) bits.push('open to everyone'); return bits.join(' \u00b7 ');
		}
		function poiLine(p) {
			if (p.kind === 'shop') return (p.shop ? p.shop : 'Shop') + (p.level ? ' \u00b7 level ' + p.level : '');
			if (p.kind === 'facility') { var f = null; var pr = layerData('progress'); if (pr && pr.facilities) pr.facilities.forEach(function (x) { if (x.id === p.id) f = x; }); return p.level > 0 ? ('Built' + (f && f.max > 1 ? ' \u00b7 level ' + p.level + ' of ' + f.max : '')) : 'Not built yet'; }
			if (p.kind === 'board') return 'Deeds for the guild';
			if (p.kind === 'cards') return 'A game of cards';
			return p.icon === 'Quest' || p.icon === 'SideQuest' ? 'Has a quest for someone' : (p.indoors ? 'Indoors' : '');
		}
		function questLine(q, t) { var bits = []; if (t.text) bits.push(t.text + (t.need > 1 ? ' (' + Math.min(t.have, t.need) + ' of ' + t.need + ')' : '')); bits.push('step ' + q.step + (q.steps ? ' of ' + q.steps : '')); if (!q.world && q.owner) bits.push(q.owner + '\u2019s quest'); return bits.join(' \u00b7 '); }
		function poiMark(p) { if (p.kind === 'shop') return 'merchant'; if (p.kind === 'board') return 'board'; if (p.kind === 'cards') return 'cards'; if (p.kind === 'facility') return /Bridge/.test(p.id) ? 'bridge' : (/Followers/.test(p.id) ? 'followers' : 'shop'); return 'npc'; }
		function bossMark(b) { return b.state === 'fight' ? 'boss_fight' : ((b.state === 'beaten' || b.state === 'down') ? 'boss_beaten' : 'boss'); }

		// ---- layers popover ---------------------------------------------------------------------------
		function layerCounts() {
			var c = {}, m = maps[current]; if (!m) return c;
			(m.pois || []).forEach(function (p) { var k = p.k; if (SITE_KINDS[k]) k = 'sites'; else if (VILLAGE_KINDS[k]) k = 'village'; c[k] = (c[k] || 0) + 1; });
			c.crystal = (m.crystals || []).length; c.passage = (m.passages || []).length;
			if (layerOn.fog) { var dx0 = discoveredSet(), hid = 0; (m.regions || []).forEach(function (r) { if (!dx0[r.id]) hid++; }); c.fog = hid; }
			if (live) {
				c.players = (live.players || []).filter(function (p) { return mapOfScene(p.scene) === current; }).length;
				c.offline = (live.offline || []).filter(function (p) { return mapOfScene(p.scene) === current; }).length;
				c.sanctum = current === 'sanctum' ? ((live.buildings || []).length + (live.farm_plots || []).length + (live.base_waygates || []).length) : 0;
				c.portal = (live.teleporters || []).filter(function (t) { return mapOfScene(t.from_scene) === current || mapOfScene(t.to_scene) === current; }).length;
				if (layerData('quests')) { var seenQ = {}; questSpots().forEach(function (o) { seenQ[o.q.id + '|' + (o.q.owner || '')] = 1; }); c.quests = Object.keys(seenQ).length; }
				if (layerData('bosses')) c.bosses = bossRows().length;
				if (layerData('chests')) c.chests = chestRows().length;
				if (layerData('pois')) c.people = poiRows().length;
				var pg = layerData('progress'); if (pg && pg.story) c.progress = pg.story.done + ' / ' + pg.story.total;
			}
			return c;
		}
		function renderLayers() {
			var c = layerCounts(); var m = maps[current];
			var rows = LAYER_DEFS.map(function (L) {
				if (L.key === 'offline' && !show.offline) return '';
				if (L.key === 'players' && !show.positions) return '';
				if (L.key === 'sanctum' && current !== 'sanctum') return '';
				if (L.key === 'fog' && !(m && m.regions && m.regions.length)) return '';
				// the owner of a link asked for the fog: the visitor cannot lift it
				if (L.key === 'fog' && mode === 'share' && opts.fog === 'world') return '';
				if (L.data && !layerData(L.data)) return '';
				var sw = L.icon ? cellHtml(L.icon) : '<span class="wgc-cell wgc-cell-text">' + (L.key === 'fog' ? '&#9729;' : 'Aa') + '</span>';
				var row = '<div class="wgc-layer' + (layerOn[L.key] ? '' : ' off') + '" data-layer="' + L.key + '">' + sw + '<span class="wgc-grow">' + L.label + (L.note ? '<span class="wgc-note">' + L.note + '</span>' : '') + '</span><span class="wgc-count">' + (c[L.key] != null ? c[L.key] : '') + '</span></div>';
				if (L.modes && layerOn[L.key]) L.modes.forEach(function (md) { row += '<div class="wgc-fogmode wgc-mode' + (layerMode[L.key] === md[0] ? ' on' : '') + '" data-modelayer="' + L.key + '" data-mode="' + md[0] + '">' + md[1] + '</div>'; });
				if (L.key === 'fog' && layerOn.fog) {
					var people = {}; ((live && live.players) || []).concat((live && live.offline) || []).forEach(function (p) { if (p.name) people[p.name] = 1; });
					row += '<div class="wgc-fogmode' + (fogPlayer ? '' : ' on') + '" data-fogmode="">Anything any adventurer has discovered</div>';
					Object.keys(people).sort().forEach(function (name) { row += '<div class="wgc-fogmode' + (fogPlayer === name ? ' on' : '') + '" data-fogmode="' + esc(name) + '">Only what ' + esc(name) + ' has discovered</div>'; });
				}
				return row;
			}).join('');
			var regs = (m && m.regions) || []; var ex = exploredSet(); var n = 0; regs.forEach(function (r) { if (ex[r.id]) n++; });
			var explored = regs.length ? '<div class="wgc-sub">Explored ground <span class="wgc-num">' + n + ' / ' + regs.length + '</span></div><div class="wgc-regions">' + regs.map(function (r) { return '<span class="wgc-region' + (ex[r.id] ? ' found' : '') + '">' + esc(r.label) + '</span>'; }).join('') + '</div>'
				+ (live && live.world ? '<div class="wgc-muted">' + (live.world.share_regions ? 'Crystals are shared: one find reveals it for everyone.' : 'Crystals are per adventurer; this shows everything anyone has found.') + '</div>' : '') : '<div class="wgc-muted">This area has no map crystals: it is always on the map.</div>';
			var older = (mode === 'panel' && live && !live.layers) ? '<div class="wgc-muted">Restart the server to add quests, bosses, chests, people and world progress to this map.</div>' : '';
			var keepScroll = layersEl.scrollTop;
			layersEl.innerHTML = '<div class="wgc-sub">Layers</div>' + rows + older + explored;
			layersEl.scrollTop = keepScroll;
			var rs = layersEl.querySelectorAll('.wgc-layer');
			for (var i = 0; i < rs.length; i++) rs[i].addEventListener('click', function () { var k = this.getAttribute('data-layer'); layerOn[k] = !layerOn[k]; this.classList.toggle('off', !layerOn[k]); savePrefs(); if (k === 'fog') fogCache = {}; renderLayers(); paintProgress(); draw(); });
			var fm = layersEl.querySelectorAll('.wgc-fogmode');
			for (var j = 0; j < fm.length; j++) fm[j].addEventListener('click', function () {
				var ml = this.getAttribute('data-modelayer');
				if (ml) { layerMode[ml] = this.getAttribute('data-mode'); savePrefs(); renderLayers(); draw(); return; }
				fogPlayer = this.getAttribute('data-fogmode') || ''; fogCache = {}; renderLayers(); draw();
			});
		}
		function toggleLayers(force) { layersOpen = (force == null) ? !layersOpen : !!force; layersEl.style.display = layersOpen ? 'block' : 'none'; zoom.querySelector('.wgc-layersbtn').classList.toggle('on', layersOpen); }

		// ---- view ---------------------------------------------------------------------------------------
		function landBox() {
			var m = maps[current]; if (!m) return null;
			var L = m.land || { u0: 0, v0: 0, u1: 1, v1: 1 };
			return { x0: m.bottom_left[0] + L.u0 * m.spanX, x1: m.bottom_left[0] + L.u1 * m.spanX, y1: m.top_right[1] - L.v0 * m.spanY, y0: m.top_right[1] - L.v1 * m.spanY };
		}
		function fitScaleValue() {
			var r = canvas.getBoundingClientRect(); var b = landBox(); if (!r.width || !r.height || !b) return 0;
			var w = r.width - INSET.left - INSET.right, h = r.height - INSET.top - INSET.bottom;
			var sx0 = b.x1 - b.x0, sy0 = b.y1 - b.y0, pad = Math.max(sx0, sy0) * FIT_PAD;
			return Math.min(w / (sx0 + 2 * pad), h / (sy0 + 2 * pad));
		}
		function fitView() {
			var s = fitScaleValue(); var b = landBox(); if (!s || !b) return;
			view.scale = s;
			view.cx = (b.x0 + b.x1) / 2 + ((INSET.right - INSET.left) / 2) / s;
			view.cy = (b.y0 + b.y1) / 2 - ((INSET.bottom - INSET.top) / 2) / s;
			view.user = false;
		}
		// everything that arrives on its own (a tile, a sheet, the feed, a pointer move) asks for a
		// frame; a dozen tiles landing together are one draw, not a dozen
		function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(function () { drawQueued = false; draw(); }); }
		function moving() { return !!(anim || dragging || (touch && touch.mode)); }
		function clampView() { var b = landBox(); if (!b) return; var m = 60; view.cx = Math.max(b.x0 - m, Math.min(b.x1 + m, view.cx)); view.cy = Math.max(b.y0 - m, Math.min(b.y1 + m, view.cy)); }
		function minScale() { return (fitScaleValue() || 1) * 0.5; }
		function resize() {
			var r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return;
			dpr = window.devicePixelRatio || 1; canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
			if (!view.scale || !view.user) fitView();
			draw();
		}
		function sx(x) { return (x - view.cx) * view.scale + canvas.width / dpr / 2; }
		function sy(y) { return (view.cy - y) * view.scale + canvas.height / dpr / 2; }
		// Above the picture's own density the zoom moves in whole multiples of it (1x, 2x,
		// 3x, 4x native), so every picture pixel is an even block of screen pixels, the way
		// the game's own point-sampled map zooms; the ceiling is the game's (4x native).
		// Below native the zoom is continuous.
		function snapScale(ns, cur) {
			var m = maps[current]; if (!m || !m.art) return Math.max(minScale(), Math.min(ns, 16));
			var N = nativePpu(m), MAXM = maxOverNative(m);
			var dev = ns * dpr, curDev = cur * dpr;
			if (dev <= N + 1e-6) return Math.max(minScale(), ns);
			// a filtered source zooms continuously up to its ceiling; a point-sampled one in whole multiples
			if (!pointSampled(m)) return Math.max(minScale(), Math.min(ns, (N * MAXM) / dpr));
			var mult;
			if (ns > cur) mult = (curDev < N - 1e-6) ? 1 : Math.min(MAXM, Math.floor(curDev / N + 1e-6) + 1);
			else mult = Math.max(1, Math.ceil(curDev / N - 1e-6) - 1);
			return (mult * N) / dpr;
		}
		// A zoom step is a short eased glide of what is on screen towards the target, while the target
		// level's tiles are fetched and decoded; the sharp picture replaces it in one frame when it is
		// whole. Steps stack: a second notch during a glide aims from the first one's target.
		// factor = how far to zoom from the step already aimed at; instant = a pinch, which is its own motion
		function zoomTo(mx, my, ns, instant, factor) {
			var r = canvas.getBoundingClientRect();
			var wx = view.cx + (mx - r.width / 2) / view.scale, wy = view.cy - (my - r.height / 2) / view.scale;
			var from = view.scale, base = anim ? anim.to : view.scale;
			var to = snapScale(factor ? base * factor : ns, base);
			lastPointer = { mx: mx, my: my }; view.user = true;
			var m = maps[current];
			// ask for the target's tiles NOW, for the view the glide will end on
			if (m && m.art && m.art.levels) { var tcx = wx - (mx - r.width / 2) / to, tcy = wy + (my - r.height / 2) / to, TL = pickLevel(m, to * dpr); dropStalePrefetch(TL.ppu); levelReady(current, m, TL, tcx, tcy, to, true, false); }
			perf.viewAt = performance.now(); perf.sharpAt = 0;
			if (instant || calm || Math.abs(to - from) < 1e-9) { anim = null; view.scale = to; view.cx = wx - (mx - r.width / 2) / to; view.cy = wy + (my - r.height / 2) / to; clampView(); draw(); return; }
			anim = { from: from, to: to, t0: performance.now(), mx: mx, my: my, wx: wx, wy: wy, w: r.width, h: r.height };
			glide();
		}
		function glide() {
			requestAnimationFrame(function (now) {
				if (!anim) return;
				var k = Math.min(1, (now - anim.t0) / ZOOM_MS), e = 1 - Math.pow(1 - k, 3);
				view.scale = k >= 1 ? anim.to : anim.from * Math.pow(anim.to / anim.from, e);
				view.cx = anim.wx - (anim.mx - anim.w / 2) / view.scale; view.cy = anim.wy + (anim.my - anim.h / 2) / view.scale;
				if (k >= 1) anim = null;
				clampView(); draw();
				if (anim) glide();
			});
		}
		// for the harness and the share page: put a world point at the centre at a given scale
		function setView(cx, cy, scale) {
			view.cx = cx; view.cy = cy;
			if (scale) view.scale = Math.max(minScale(), Math.min(scale, (nativePpu(maps[current] || {}) * maxOverNative(maps[current] || {})) / dpr));
			view.user = true; clampView(); draw();
		}
		canvas.addEventListener('mousemove', function (e) { var r = canvas.getBoundingClientRect(); lastPointer = { mx: e.clientX - r.left, my: e.clientY - r.top }; });
		canvas.addEventListener('mousedown', function (e) { anim = null; dragging = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }; canvas.classList.add('drag'); e.preventDefault(); });
		window.addEventListener('mouseup', function () { if (!dragging) return; dragging = null; canvas.classList.remove('drag'); requestDraw(); });
		window.addEventListener('mousemove', function (e) { if (!dragging) return; view.cx = dragging.cx - (e.clientX - dragging.x) / view.scale; view.cy = dragging.cy + (e.clientY - dragging.y) / view.scale; view.user = true; clampView(); requestDraw(); });
		canvas.addEventListener('wheel', function (e) { e.preventDefault(); var r = canvas.getBoundingClientRect(); zoomTo(e.clientX - r.left, e.clientY - r.top, 0, false, e.deltaY < 0 ? 1.3 : 0.77); }, { passive: false });
		canvas.addEventListener('touchstart', function (e) {
			if (e.touches.length === 1) touch = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, cx: view.cx, cy: view.cy, t0: Date.now(), moved: false };
			else if (e.touches.length === 2) { var r = canvas.getBoundingClientRect(); var dx = e.touches[1].clientX - e.touches[0].clientX, dy = e.touches[1].clientY - e.touches[0].clientY; touch = { mode: 'pinch', d: Math.sqrt(dx * dx + dy * dy) || 1, scale: view.scale, mx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, my: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top }; }
		}, { passive: true });
		canvas.addEventListener('touchmove', function (e) {
			if (!touch) return; e.preventDefault();
			if (touch.mode === 'pan' && e.touches.length === 1) { if (Math.abs(e.touches[0].clientX - touch.x) + Math.abs(e.touches[0].clientY - touch.y) > 8) touch.moved = true; view.cx = touch.cx - (e.touches[0].clientX - touch.x) / view.scale; view.cy = touch.cy + (e.touches[0].clientY - touch.y) / view.scale; view.user = true; clampView(); requestDraw(); }
			else if (touch.mode === 'pinch' && e.touches.length === 2) { var dx = e.touches[1].clientX - e.touches[0].clientX, dy = e.touches[1].clientY - e.touches[0].clientY; zoomTo(touch.mx, touch.my, touch.scale * (Math.sqrt(dx * dx + dy * dy) / touch.d), true); }
		}, { passive: false });
		canvas.addEventListener('touchend', function () {
			// a tap (no drag, short) asks what is under the finger; the answer stays a few seconds
			if (touch && touch.mode === 'pan' && !touch.moved && Date.now() - touch.t0 < 450) { var r = canvas.getBoundingClientRect(), mx = touch.x - r.left, my = touch.y - r.top; var ht = pick(mx, my); showTip(ht, mx, my); clearTimeout(tipTimer); if (ht) tipTimer = setTimeout(function () { showTip(null); }, 4000); }
			touch = null; requestDraw();
		}, { passive: true });
		zoom.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var r = canvas.getBoundingClientRect(); var z = b.getAttribute('data-z'); if (z === 'layers') { toggleLayers(); return; } if (z === 'fit') { fitView(); draw(); } else zoomTo(r.width / 2, r.height / 2, 0, false, z === 'in' ? 1.45 : 0.69); });
		// the pointer nearing the zoom buttons is a zoom about to happen: fetch the next level around the centre
		zoom.addEventListener('pointerenter', function () { lastPointer = null; prefetch(); });

		// ---- draw ---------------------------------------------------------------------------------------
		function drawMark(kind, x, y, size) {
			var i = MARKER_CELLS.indexOf(kind), sheet = markers;
			if (i < 0) { i = MARKER_CELLS2.indexOf(kind); sheet = markers2; }
			if (!sheet || i < 0) { ctx.beginPath(); ctx.arc(x, y, size * 0.3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(244,184,74,0.85)'; ctx.fill(); return; }
			ctx.drawImage(sheet, i * CELL, 0, CELL, CELL, x - size / 2, y - size / 2, size, size);
		}
		function markSize() { return Math.max(11, Math.min(34, 9 + view.scale * 3.2)); }
		function fogLayer(m) {
			var rg = regionsImg[current]; if (!rg || !layerOn.fog) return null;
			var ex = discoveredSet(); var sig = current + '|' + fogPlayer + '|' + Object.keys(ex).sort().join(',');
			if (fogCache.sig === sig) return fogCache.canvas;
			var unexplored = {}; var any = false;
			var pieces = {}; (m.fog || []).forEach(function (f) { pieces[f.id] = 1; });
			(m.regions || []).forEach(function (r) { if (!ex[r.id] && !pieces[r.id]) { unexplored[r.index] = 1; any = true; } });
			if (!any) { fogCache = { sig: sig, canvas: null }; return null; }
			var sw = Math.max(1, Math.round(rg.width / 4)), sh = Math.max(1, Math.round(rg.height / 4));
			var off = document.createElement('canvas'); off.width = sw; off.height = sh;
			var oc = off.getContext('2d'); oc.imageSmoothingEnabled = false; oc.drawImage(rg, 0, 0, sw, sh);
			var id; try { id = oc.getImageData(0, 0, sw, sh); } catch (e) { fogCache = { sig: sig, canvas: null }; return null; }
			var d = id.data;
			for (var i = 0; i < d.length; i += 4) { var idx = d[i]; if (idx && unexplored[idx]) { d[i] = 2; d[i + 1] = 15; d[i + 2] = 31; d[i + 3] = 150; } else { d[i + 3] = 0; } }
			oc.putImageData(id, 0, 0);
			fogCache = { sig: sig, canvas: off };
			return off;
		}
		var layer = document.createElement('canvas'), lctx = layer.getContext('2d');
		function drawLevel(m, L, dx, dy, dw, dh, ds, s, interim) {
			// ratio of screen density to the level's density: <= 1 is a clean downscale
			// (bilinear over a pre-averaged level), > 1 only ever happens on the native tiles
			// and is drawn nearest-neighbour, whole pixel blocks, the way the game does it
			var ratio = ds / L.ppu;
			// exactly 1:1 is the picture itself: drawn nearest on whole device pixels, never resampled
			// (bilinear at a fractional offset softened every texel at the native zoom)
			var exact = Math.abs(ratio - 1) < 1e-3;
			// interim = a frame of a glide, a drag, or a stand-in while the wanted level loads: always
			// smooth (a stand-in is never at a whole multiple) and at the cheap filter, so a gesture stays at 60 fps
			var smooth = interim ? !exact : (!exact && (ratio < 1 || !pointSampled(m)));
			ctx.imageSmoothingEnabled = smooth; if (smooth) ctx.imageSmoothingQuality = (interim || moving()) ? 'low' : 'high';
			if (L.file) { var img = art[current].sheets[L.ppu]; if (!img) return false;
				// a sheet covers its own pixels at its own density from the map's origin, like a tile does (an exact half of the
				// level above may run half a unit past the world span); stretching it to the span made a 1:1 sheet a 0.998 draw
				dw = img.width / L.ppu * s; dh = img.height / L.ppu * s;
				if (!smooth) { dx = Math.round(dx * dpr) / dpr; dy = Math.round(dy * dpr) / dpr; dw = Math.round(dw * dpr) / dpr; dh = Math.round(dh * dpr) / dpr; } ctx.drawImage(img, dx, dy, dw, dh); return true; }
			var T = L.tiles, bl = m.bottom_left, tr = m.top_right;
			var w = canvas.width / dpr, h = canvas.height / dpr;
			var unitsPerTile = T.size / L.ppu;
			var q = tileRange(m, L, view.cx, view.cy, s), c0 = q.c0, c1 = q.c1, r0 = q.r0, r1 = q.r1;
			var all = true;
			for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) {
				if (!T.presentSet[c + ':' + r]) continue;
				var t = tile(current, L, c, r, !!interim); if (!t) { all = false; continue; }
				// snap the tile's screen rectangle to whole device pixels so nearest blocks stay even
				var x = sx(bl[0] + c * unitsPerTile), y = sy(tr[1] - r * unitsPerTile), size = unitsPerTile * s;
				if (!smooth) { x = Math.round(x * dpr) / dpr; y = Math.round(y * dpr) / dpr; size = Math.round(size * dpr) / dpr; }
				ctx.drawImage(t, x, y, size, size);
			}
			return all;
		}
		function drawBase(m) {
			var a = art[current] || {};
			var bl = m.bottom_left, tr = m.top_right;
			var dx = sx(bl[0]), dy = sy(tr[1]), dw = m.spanX * view.scale, dh = m.spanY * view.scale;
			var s = view.scale, ds = devScale();
			var fog = fogLayer(m);
			var target = ctx;
			if (fog && m.fogWorld) { if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; } lctx.setTransform(dpr, 0, 0, dpr, 0, 0); lctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr); target = lctx; }
			var ctxMain = ctx; ctx = target;
			var drew = false, L = null;
			if (m.art && m.art.levels) {
				// The level this density wants. At rest its tiles are asked for. A CHANGE of level never
				// shows tile by tile: what is on screen stays, scaled (the level held from the last whole
				// frame, else any level whose tiles for this view are all decoded, else the largest sheet),
				// and the wanted level replaces it in ONE frame. New ground at the SAME level (a pan) keeps
				// every sharp tile it has and fills the gap from the level below until the rest arrives.
				var glideFrame = !!anim;
				var want = pickLevel(m, glideFrame ? anim.to * dpr : ds);
				var ready = levelReady(current, m, want, view.cx, view.cy, s, !glideFrame, false);
				wantedLevel = want.ppu; levelIsReady = ready && !glideFrame;
				var h0 = held[current], Ls = m.art.levels, i, show = null;
				var standIn = function (skip) {
					var order = [], k;
					if (h0 && h0 !== skip) order.push(h0);
					if (glideFrame && ready && want !== skip) order.push(want);
					for (k = Ls.length - 1; k >= 0; k--) if (Ls[k].tiles && Ls[k].ppu <= want.ppu && Ls[k] !== h0 && Ls[k] !== skip) order.push(Ls[k]);
					for (k = 0; k < Ls.length; k++) if (Ls[k].tiles && Ls[k].ppu > want.ppu && Ls[k] !== h0 && Ls[k] !== skip) order.push(Ls[k]);
					for (k = 0; k < order.length; k++) if (levelReady(current, m, order[k], view.cx, view.cy, s, false, false)) return order[k];
					for (k = Ls.length - 1; k >= 0; k--) if (Ls[k].file && a.sheets[Ls[k].ppu]) return Ls[k];
					return null;
				};
				if (ready && !glideFrame) { show = want; if (drawLevel(m, want, dx, dy, dw, dh, ds, s, false) || want.file) drew = true; held[current] = want; }
				else if (!glideFrame && h0 === want && want.tiles) {
					var under = standIn(want); if (under) { drawLevel(m, under, dx, dy, dw, dh, ds, s, true); drew = true; }
					if (drawLevel(m, want, dx, dy, dw, dh, ds, s, false)) drew = true; drew = drew || !!under; show = want;
				}
				else { show = standIn(null); if (show) { drawLevel(m, show, dx, dy, dw, dh, ds, s, true); drew = true; } else if (want.tiles) { if (drawLevel(m, want, dx, dy, dw, dh, ds, s, false)) drew = true; show = want; } }
				drawnLevel = (show || want).ppu;
				L = show || want;
			}
			ctx.imageSmoothingEnabled = true;
			if (!drew && !a.missing) { ctx.font = '14px "Pixel Operator", "Open Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(167,184,183,0.8)'; ctx.fillText('Unrolling the map\u2026', canvas.width / dpr / 2, canvas.height / dpr / 2); ctx.textAlign = 'left'; }
			if (a.missing && !drew) { ctx.font = '14px "Pixel Operator", "Open Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(167,184,183,0.8)'; ctx.fillText('The map pictures for this area are not installed.', canvas.width / dpr / 2, canvas.height / dpr / 2); ctx.textAlign = 'left'; }
			if (layerOn.fog && drew) drawFog(m, s);
			if (fog && m.fogWorld) {
				var W = m.fogWorld;
				ctx.globalCompositeOperation = 'source-atop'; ctx.imageSmoothingEnabled = false;
				ctx.drawImage(fog, sx(W.x0), sy(W.y1), (W.x1 - W.x0) * s, (W.y1 - W.y0) * s);
				ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = true;
				ctx = ctxMain;
				ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			}
			ctx = ctxMain;
		}
		// After a whole frame at rest: fetch, at low priority, the NEXT FINER LEVEL for the view in which
		// it will first appear (the notches from here until the density passes the level on screen, the
		// pointer's world point kept under the pointer), and the ring around the view for a pan. A level
		// change is every second to fourth notch, so the tiles are usually decoded before they are wanted.
		function prefetch() {
			var m = maps[current]; if (!m || !m.art || !m.art.levels || moving()) return;
			if (navigator.connection && navigator.connection.saveData) return;
			var r = canvas.getBoundingClientRect(); if (!r.width) return;
			var H = held[current]; if (!H) return;
			var mx = lastPointer ? lastPointer.mx : r.width / 2, my = lastPointer ? lastPointer.my : r.height / 2;
			var wx = view.cx + (mx - r.width / 2) / view.scale, wy = view.cy - (my - r.height / 2) / view.scale;
			var to = view.scale, guard = 0;
			do { var nx = snapScale(to * 1.3, to); if (nx <= to + 1e-9) { to = 0; break; } to = nx; } while (to * dpr <= H.ppu + 1e-6 && ++guard < 8);
			if (to) { var L = pickLevel(m, to * dpr); if (L.tiles && L !== H) levelReady(current, m, L, wx - (mx - r.width / 2) / to, wy + (my - r.height / 2) / to, to, true, true); }
			if (H.tiles) levelReady(current, m, H, view.cx, view.cy, view.scale * 0.75, true, true);
		}
		function draw() {
			if (!canvas.width) return;
			frameClock = ++useClock; perf.draws++;
			var w = canvas.width / dpr, h = canvas.height / dpr, i;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
			// the floor under the picture: the page's own night sky, flat; nothing is ever
			// drawn over the picture itself unless a layer says so
			ctx.fillStyle = '#020f1f'; ctx.fillRect(0, 0, w, h);
			var m = maps[current]; if (!m) return;
			drawBase(m);

			var ms = markSize(); var placed = [];
			hits = []; drawnLayers = { quests: 0, bosses: 0, chests: 0, people: 0 };
			function hit(x, y, r, title, sub) { hits.push({ x: x, y: y, r: Math.max(10, r), title: title, sub: sub || '' }); }
			function onScreen(x, y) { return x > -40 && y > -40 && x < w + 40 && y < h + 40; }
			var hide = function (wx, wy) { if (underFog(m, wx, wy)) { fogMarkersHidden++; return true; } return false; };
			if (layerOn.passage) (m.passages || []).forEach(function (p) { var x = sx(p.x), y = sy(p.y); if (!onScreen(x, y) || hide(p.x, p.y)) return; if (p.to_x != null && p.to_uv) { ctx.strokeStyle = 'rgba(244,184,74,0.4)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(sx(p.to_x), sy(p.to_y)); ctx.stroke(); ctx.setLineDash([]); } ctx.beginPath(); ctx.arc(x, y, ms * 0.22, 0, Math.PI * 2); ctx.fillStyle = 'rgba(244,184,74,0.75)'; ctx.fill(); });
			(m.pois || []).forEach(function (p) {
				var key = p.k; if (SITE_KINDS[key]) key = 'sites'; else if (VILLAGE_KINDS[key]) key = 'village';
				if (!layerOn[key]) return;
				var x = sx(p.x), y = sy(p.y); if (!onScreen(x, y) || hide(p.x, p.y)) return;
				drawMark(p.k, x, y, p.k === 'waygate' ? ms * 1.25 : ms);
				if (p.n) hit(x, y, ms * 0.6, p.n, '');
			});
			if (layerOn.crystal) { var got = {}; if (live && live.crystals) live.crystals.forEach(function (c) { got[c.id] = c.collected; }); (m.crystals || []).forEach(function (c) { var x = sx(c.x), y = sy(c.y); if (!onScreen(x, y) || hide(c.x, c.y)) return; ctx.globalAlpha = got[c.id] ? 0.45 : 1; drawMark('crystal', x, y, ms * 0.95); ctx.globalAlpha = 1; if (got[c.id]) { ctx.strokeStyle = 'rgba(139,108,246,0.95)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - ms * 0.22, y + ms * 0.02); ctx.lineTo(x - ms * 0.06, y + ms * 0.2); ctx.lineTo(x + ms * 0.26, y - ms * 0.18); ctx.stroke(); } }); }
			if (current === 'sanctum' && layerOn.sanctum && live) {
				(live.farm_plots || []).forEach(function (f) { var x = sx(f.x), y = sy(f.y); if (onScreen(x, y)) drawMark('farm', x, y, ms * 0.7); });
				(live.buildings || []).forEach(function (b) { var x = sx(b.x), y = sy(b.y); if (onScreen(x, y)) drawMark('building', x, y, ms * 0.6); });
				(live.base_waygates || []).forEach(function (b) { var x = sx(b.x), y = sy(b.y); if (onScreen(x, y)) drawMark('waystone', x, y, ms); });
			}
			if (layerOn.portal && live && live.teleporters) live.teleporters.forEach(function (t) { var a = mapOfScene(t.from_scene) === current, b = mapOfScene(t.to_scene) === current; if (a && b) { ctx.strokeStyle = 'rgba(139,108,246,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(sx(t.fx), sy(t.fy)); ctx.lineTo(sx(t.tx), sy(t.ty)); ctx.stroke(); ctx.setLineDash([]); } if (a) { ctx.beginPath(); ctx.arc(sx(t.fx), sy(t.fy), ms * 0.32, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(139,108,246,0.95)'; ctx.lineWidth = 2; ctx.stroke(); } if (b) { ctx.beginPath(); ctx.arc(sx(t.tx), sy(t.ty), ms * 0.32, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(139,108,246,0.95)'; ctx.lineWidth = 2; ctx.stroke(); } });
			drawLiveLayers(m, ms, w, h, placed, onScreen, hide, hit);
			if (layerOn.names) {
				ctx.font = '700 ' + (view.scale > 2.5 ? 14 : 12) + 'px "Pixel Operator", "Open Sans", sans-serif';
				var ex = exploredSet();
				if (view.scale > 1.2) (m.regions || []).forEach(function (r) { if (!r.uv || !ex[r.id]) return; var x = sx(r.x), y = sy(r.y) - ms * 0.9; if (!onScreen(x, y)) return; placeLabel(r.label, x, y, w, placed, 'rgba(244,233,210,0.9)', true, 1); });
				if (view.scale <= 1.2 || m.key !== 'earlwood') {
					var scenesBySize = (m.scenes || []).slice().sort(function (a, b) { return b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]; });
					scenesBySize.forEach(function (s) { var pw = s.rect[2] * view.scale; var tw = ctx.measureText(s.label).width; if (pw < tw * 0.9 && view.scale < 1.2) return; var x = sx(s.rect[0] + s.rect[2] / 2), y = sy(s.rect[1] + s.rect[3] / 2); if (!onScreen(x, y) || hide(s.rect[0] + s.rect[2] / 2, s.rect[1] + s.rect[3] / 2) || sceneUnderFog(m, s.scene)) return; placeLabel(s.label, x, y, w, placed, 'rgba(244,233,210,0.78)', true, 2); });
				}
			}
			if (layerOn.waygate && view.scale >= 1.6) { ctx.font = '700 12px "Pixel Operator", "Open Sans", sans-serif'; (m.pois || []).forEach(function (p) { if (p.k !== 'waygate') return; var x = sx(p.x), y = sy(p.y); if (!onScreen(x, y) || hide(p.x, p.y)) return; placeLabel(p.n, x + ms * 0.7, y, w, placed, '#f4b84a', false); }); }
			if (layerOn.offline && show.offline && live && live.offline) live.offline.forEach(function (p) { if (mapOfScene(p.scene) !== current) return; var pt = playerPoint(p); var x = sx(pt.x), y = sy(pt.y); if (onScreen(x, y)) { ctx.globalAlpha = 0.7; drawMark('ghost', x, y, ms * 0.95); ctx.globalAlpha = 1; } });
			if (layerOn.players && show.positions && live && live.players) {
				var chips = [];
				live.players.forEach(function (p) {
					if (mapOfScene(p.scene) !== current) return;
					var pt = playerPoint(p); var x = sx(pt.x), y = sy(pt.y); if (!onScreen(x, y)) return;
					var ps = Math.max(16, Math.min(38, ms * 1.35)), col = 'hsl(' + hue(p.name || '') + ',60%,55%)';
					ctx.beginPath(); ctx.arc(x, y, ps * 0.66, 0, Math.PI * 2); ctx.fillStyle = 'rgba(24,237,246,0.16)'; ctx.fill();
					ctx.beginPath(); ctx.arc(x, y, ps * 0.5 + 1.5, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = 2; if (p.teleporting) ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
					if (p.dead) ctx.globalAlpha = 0.55; drawMark('player', x, y, ps); ctx.globalAlpha = 1;
					if (show.names && (ps >= 16 || live.players.length <= 8)) chips.push({ x: x, y: y, name: p.name, ps: ps, col: col, hp: (show.health && p.hp_max > 0) ? p.hp / p.hp_max : null });
				});
				ctx.font = '700 12px "Pixel Operator", "Open Sans", sans-serif';
				var pc = [];
				chips.forEach(function (c) {
					var cell = Math.round(c.x / 100) + ':' + Math.round(c.y / 18); if (pc.indexOf(cell) >= 0) return; pc.push(cell);
					var tw = ctx.measureText(c.name).width, cx = c.x + c.ps * 0.55, cy = c.y - c.ps * 0.42;
					if (cx + tw + 10 > w - 6) cx = c.x - c.ps * 0.55 - tw - 10; if (cx < 6) cx = 6;
					ctx.fillStyle = 'rgba(2,15,31,0.92)'; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(cx - 5, cy - 6, tw + 10, c.hp != null ? 22 : 18, 3); else ctx.rect(cx - 5, cy - 6, tw + 10, c.hp != null ? 22 : 18); ctx.fill();
					ctx.strokeStyle = c.col; ctx.lineWidth = 1; ctx.stroke();
					ctx.fillStyle = '#f4e9d2'; ctx.fillText(c.name, cx, cy + 7);
					if (c.hp != null) { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(cx, cy + 11, tw, 3); ctx.fillStyle = c.hp < 0.35 ? '#ef6464' : '#4cf77c'; ctx.fillRect(cx, cy + 11, tw * Math.max(0, Math.min(1, c.hp)), 3); }
				});
			}
			var opt = [5, 10, 25, 50, 100, 250, 500], best = 5; for (i = 0; i < opt.length; i++) if (opt[i] * view.scale <= 140) best = opt[i];
			// the scale bar is DOM: written when it changes, and never in the middle of a glide (a write per
			// frame made every frame a style, layout and paint pass over the tool)
			var barW = Math.max(20, Math.round(best * view.scale)), barKey = barW + '|' + best;
			if (barKey !== lastBar && !anim) { lastBar = barKey; scaleEl.querySelector('.wgc-scale-bar').style.width = barW + 'px'; scaleEl.querySelector('.wgc-scale-label').textContent = best + ' units'; }
			if (levelIsReady && !moving()) { if (!perf.sharpAt) perf.sharpAt = performance.now(); clearTimeout(prefetchTimer); prefetchTimer = setTimeout(prefetch, 60); }
		}
		// The live layers. Everything here stands on ground, so everything here asks the fog first: a mark on
		// ground nobody has discovered is withheld, exactly like a landmark, or the fog would keep nothing.
		function drawLiveLayers(m, ms, w, h, placed, onScreen, hide, hit) {
			var labels = [];
			if (layerOn.chests && layerData('chests')) chestRows().forEach(function (c) {
				var pt = placeOf(c.scene, c.x, c.y), x = sx(pt.x), y = sy(pt.y); if (!onScreen(x, y) || hide(pt.x, pt.y)) return;
				var loot = c.kind === 'loot'; if (loot && c.opened) ctx.globalAlpha = 0.8;
				drawMark(loot ? (c.opened ? 'chest_open' : 'chest') : 'chest_player', x, y, ms); ctx.globalAlpha = 1; drawnLayers.chests++;
				hit(x, y, ms * 0.55, loot ? 'Loot chest' : (c.name || 'Storage chest'), chestLine(c));
			});
			// everyone inside one building stands at its door on this map: one mark for the building, the names in its tip
			var indoorsBy = {};
			if (layerOn.people && layerData('pois')) poiRows().forEach(function (p) { if (catalog.indoor && catalog.indoor[p.scene]) (indoorsBy[p.scene] = indoorsBy[p.scene] || []).push(p); });
			Object.keys(indoorsBy).forEach(function (scene) {
				var d = catalog.indoor[scene], x = sx(d.x), y = sy(d.y); if (!onScreen(x, y) || hide(d.x, d.y)) return;
				var rows = indoorsBy[scene], board = rows.filter(function (p) { return p.kind === 'board'; }).length > 0;
				drawMark(board ? 'board' : 'npc', x, y, ms); drawnLayers.people += rows.length;
				var names = rows.filter(function (p) { return p.kind === 'npc' || p.kind === 'shop'; }).map(function (p) { return p.name; }), extra = rows.filter(function (p) { return p.kind !== 'npc' && p.kind !== 'shop'; }).map(function (p) { return p.name.charAt(0).toLowerCase() + p.name.slice(1); });
				var label = scene.replace(/([a-z])([A-Z])/g, '$1 $2');
				hit(x, y, ms * 0.55, label, (names.length ? 'Inside: ' + names.join(', ') : '') + (extra.length ? (names.length ? ' \u00b7 ' : '') + extra.join(', ') : ''));
				if (view.scale >= 1.6) labels.push({ t: label, x: x + ms * 0.62, y: y, c: '#a9e6a0' });
			});
			if (layerOn.people && layerData('pois')) poiRows().forEach(function (p) {
				if (catalog.indoor && catalog.indoor[p.scene]) return;
				var pt = placeOf(p.scene, p.x, p.y), x = sx(pt.x), y = sy(pt.y); if (!onScreen(x, y) || hide(pt.x, pt.y)) return;
				var person = p.kind === 'npc' || p.kind === 'shop', unbuilt = p.kind === 'facility' && !(p.level > 0);
				if (unbuilt) ctx.globalAlpha = 0.5;
				drawMark(poiMark(p), x, y, person ? ms * 1.2 : ms * 1.05); ctx.globalAlpha = 1; drawnLayers.people++;
				if (p.icon === 'Quest' || p.icon === 'SideQuest') drawMark('quest', x + ms * 0.42, y - ms * 0.42, ms * 0.6);
				hit(x, y, ms * 0.55, p.name || 'Someone', poiLine(p));
				if (person && view.scale >= 1.6) labels.push({ t: p.name, x: x + ms * 0.62, y: y, c: '#a9e6a0' });
			});
			if (layerOn.quests && layerData('quests')) questSpots().forEach(function (o) {
				var q = o.q, t = o.t, pt = placeOf(t.scene, t.x, t.y), x = sx(pt.x), y = sy(pt.y), r = Math.max(4, t.r || 10) * view.scale;
				if (x + r < -40 || y + r < -40 || x - r > w + 40 || y - r > h + 40 || hide(pt.x, pt.y)) return;
				var own = !q.world, rgb = own ? '24,237,246' : '244,184,74';
				ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(' + rgb + ',0.13)'; ctx.fill();
				ctx.strokeStyle = 'rgba(' + rgb + ',0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
				drawMark(own ? 'quest_own' : 'quest', x, y, ms * 1.35); drawnLayers.quests++;
				hit(x, y, Math.max(ms * 0.6, Math.min(r, 40)), q.name, questLine(q, t));
				labels.push({ t: q.name, x: x + ms * 0.7, y: y, c: own ? '#18edf6' : '#f4b84a' });
			});
			if (layerOn.bosses && layerData('bosses')) bossRows().forEach(function (b) {
				var at = (b.x != null && b.state !== 'beaten') ? { x: b.x, y: b.y } : { x: b.lair_x, y: b.lair_y }; if (at.x == null) return;
				var pt = placeOf(b.scene, at.x, at.y), x = sx(pt.x), y = sy(pt.y); if (!onScreen(x, y) || hide(pt.x, pt.y)) return;
				var size = Math.max(20, b.rank === 'MiniBoss' ? ms * 1.35 : ms * 1.75);
				if (b.state === 'fight') { ctx.beginPath(); ctx.arc(x, y, size * 0.75, 0, Math.PI * 2); ctx.fillStyle = 'rgba(239,100,100,0.18)'; ctx.fill(); ctx.strokeStyle = 'rgba(239,100,100,0.95)'; ctx.lineWidth = 2; ctx.stroke(); }
				if (b.state === 'waiting') ctx.globalAlpha = 0.6;
				drawMark(bossMark(b), x, y, size); ctx.globalAlpha = 1; drawnLayers.bosses++;
				if ((b.state === 'fight' || b.state === 'alive') && b.hp_max > 0) { var bw = size * 1.3, f = Math.max(0, Math.min(1, b.hp / b.hp_max)); ctx.fillStyle = 'rgba(2,15,31,0.9)'; ctx.fillRect(x - bw / 2 - 1, y + size * 0.55 - 1, bw + 2, 6); ctx.fillStyle = '#ef6464'; ctx.fillRect(x - bw / 2, y + size * 0.55, bw * f, 4); }
				hit(x, y, size * 0.6, b.name, bossLine(b));
				if (view.scale >= 0.9 || b.state === 'fight') labels.push({ t: b.name, x: x + size * 0.62, y: y, c: b.state === 'beaten' ? '#a7b8b7' : '#ef8a8a' });
			});
			if (layerOn.names && labels.length) { ctx.font = '700 12px "Pixel Operator", "Open Sans", sans-serif'; labels.forEach(function (l) { if (l.t) placeLabel(l.t, l.x, l.y, w, placed, l.c, false); }); }
		}
		// The tooltip: what a mark is, in words (Lodestone's shape: the name, then the facts). A mouse hovers, a finger taps.
		function pick(mx, my) { var best = null, bd = 1e9; for (var i = hits.length - 1; i >= 0; i--) { var ht = hits[i], d = Math.sqrt((ht.x - mx) * (ht.x - mx) + (ht.y - my) * (ht.y - my)); if (d <= ht.r && d < bd - 3) { bd = d; best = ht; } } return best; }   // marks on one spot: the one drawn on top answers, unless another is clearly nearer
		function showTip(ht, mx, my) {
			if (!ht) { if (hot) { hot = null; tipEl.classList.remove('on'); } return; }
			hot = ht; tipEl.firstChild.textContent = ht.title; tipEl.lastChild.textContent = ht.sub; tipEl.classList.add('on');
			var r = canvas.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight, x = mx + 14, y = my - th - 8;
			if (x + tw > r.width - 6) x = mx - tw - 14; if (x < 6) x = 6; if (y < 6) y = my + 16;
			tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
		}
		canvas.addEventListener('mousemove', function (e) { if (dragging) { showTip(null); return; } var r = canvas.getBoundingClientRect(); showTip(pick(e.clientX - r.left, e.clientY - r.top), e.clientX - r.left, e.clientY - r.top); });
		canvas.addEventListener('mouseleave', function () { showTip(null); });
		// the progress card: where this world stands, folded to one line until asked
		function paintProgress() {
			var pg = layerData('progress');
			if (!pg || !layerOn.progress || !pg.story) { progEl.style.display = 'none'; return; }
			var day = (pg.month > 0 ? 'Month ' + (pg.month + 1) + ', day ' : 'Day ') + ((pg.day || 0) + 1);
			var head = '<button type="button" class="wgc-prog-head" aria-expanded="' + (progOpen ? 'true' : 'false') + '">' + cellHtml('progress') + '<span class="wgc-prog-line"><b>Story</b> ' + pg.story.done + ' / ' + pg.story.total + (pg.bosses ? ' <i>\u00b7</i> <b>Bosses</b> ' + pg.bosses.beaten + ' / ' + pg.bosses.total : '') + ' <i>\u00b7</i> ' + day + '</span><span class="wgc-caret">' + (progOpen ? '\u25BE' : '\u25B8') + '</span></button>';
			var body = '';
			if (progOpen) {
				var rows = [];
				rows.push(['Main story', pg.story.done + ' of ' + pg.story.total + (pg.story.current ? ' \u00b7 now: ' + esc(pg.story.current) : '')]);
				if (pg.side) rows.push(['Side quests', pg.side.done + ' of ' + pg.side.total]);
				if (pg.bosses) rows.push(['Bosses beaten', pg.bosses.beaten + ' of ' + pg.bosses.total + (pg.bosses.names && pg.bosses.names.length ? ' \u00b7 ' + pg.bosses.names.map(esc).join(', ') : '')]);
				if (pg.facilities && pg.facilities.length) { var built = pg.facilities.filter(function (f) { return f.level > 0; }); rows.push(['Village works', built.length + ' of ' + pg.facilities.length + ' built' + (built.length ? ' \u00b7 ' + built.map(function (f) { return esc(f.name) + (f.max > 1 ? ' ' + f.level + '/' + f.max : ''); }).join(', ') : '')]); }
				if (pg.guild_tier != null) rows.push(['Guild deeds', 'tier ' + pg.guild_tier]);
				if (pg.arena != null) rows.push(['Arena', 'best level ' + pg.arena]);
				if (pg.residents != null) rows.push(['Sanctum', pg.residents + (pg.residents === 1 ? ' resident' : ' residents') + (pg.workers ? ' \u00b7 ' + pg.workers + ' workers' : '')]);
				body = '<div class="wgc-prog-body">' + rows.map(function (r) { return '<div class="wgc-prog-row"><span>' + r[0] + '</span><em>' + r[1] + '</em></div>'; }).join('') + '</div>';
			}
			var sig = head + body; if (progEl.getAttribute('data-sig') !== sig) { progEl.setAttribute('data-sig', sig); progEl.innerHTML = sig; progEl.querySelector('.wgc-prog-head').addEventListener('click', function () { progOpen = !progOpen; savePrefs(); paintProgress(); }); }
			progEl.style.display = 'block';
		}
		function placeLabel(text, x, y, w, placed, fill, centred, room) {
			room = room || 1;
			var cell = Math.round(x / 80) + ':' + Math.round(y / 14); if (placed.indexOf(cell) >= 0) return;
			for (var k = 0; k < placed.length; k++) { var pr = placed[k]; if (typeof pr !== 'object') continue; if (Math.abs(pr.x - x) < (pr.hw + ctx.measureText(text).width / 2) * room && Math.abs(pr.y - y) < 14 * room) return; }
			placed.push(cell); placed.push({ x: x, y: y, hw: ctx.measureText(text).width / 2 });
			var tw = ctx.measureText(text).width; var lx = centred ? x - tw / 2 : x; if (lx + tw > w - 6) lx = w - 6 - tw; if (lx < 6) lx = 6;
			ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(2,15,31,0.92)'; ctx.strokeText(text, lx, y + 4); ctx.fillStyle = fill; ctx.fillText(text, lx, y + 4);
		}

		// ---- lifecycle ---------------------------------------------------------------------------------
		var started = false, onResize = function () { resize(); };
		function start() { if (started) return; started = true; if (!catalog) loadCatalog(); resize(); fetchLive(); timer = setInterval(fetchLive, pollMs); window.addEventListener('resize', onResize); setTimeout(resize, 50); setTimeout(resize, 400); }
		function stop() { started = false; clearInterval(timer); timer = null; window.removeEventListener('resize', onResize); }
		function state() {
			var r = canvas.getBoundingClientRect(); var b = landBox(); var a = art[current] || {};
			var loadedTiles = 0; for (var k in tiles) if (tiles[k].ok) loadedTiles++;
			return { map: current, w: r.width, h: r.height, scale: view.scale, dpr: dpr, devScale: devScale(), level: drawnLevel, wanted: wantedLevel, ready: levelIsReady, moving: moving(), view: { cx: view.cx, cy: view.cy }, user: view.user, art: !!(a.sheets && Object.keys(a.sheets).length), artMissing: !!a.missing, markers: !!markers, catalog: !!catalog, tilesReady: loadedTiles,
				pois: maps[current] ? maps[current].pois.length : 0, players: live && live.players ? live.players.length : 0, drawnPlayers: live && live.players ? live.players.filter(function (p) { return mapOfScene(p.scene) === current; }).length : 0,
				land: b ? { x0: sx(b.x0), y0: sy(b.y1), x1: sx(b.x1), y1: sy(b.y0) } : null, layers: JSON.parse(JSON.stringify(layerOn)), layerModes: JSON.parse(JSON.stringify(layerMode)), liveLayers: live && live.layers ? Object.keys(live.layers) : [], drawn: JSON.parse(JSON.stringify(drawnLayers)), hits: hits.length, markers2: !!markers2, progress: progEl.style.display !== 'none', progressOpen: progOpen, tip: hot ? { title: hot.title, sub: hot.sub } : null, explored: Object.keys(exploredSet()), fog: { on: !!layerOn.fog, player: fogPlayer, hidden: layerOn.fog ? fogHidden : 0, markersHidden: layerOn.fog ? fogMarkersHidden : 0, pieces: maps[current] ? (maps[current].fog || []).length : 0, loaded: Object.keys(fogImgs).filter(function (k) { return k.indexOf(current + '/') === 0 && fogImgs[k].bmp; }).length, discovered: Object.keys(discoveredSet()) }, badge: badge.textContent, tilesLoaded: tileOrder.length, tilesDecoded: loadedTiles };
		}
		window.wgcMapState = state;
		var api = { start: start, stop: stop, resize: resize, state: state, select: function (k) { selectMap(k, true); }, refresh: fetchLive, layers: toggleLayers, setView: setView, zoom: function (f) { var r = canvas.getBoundingClientRect(); zoomTo(r.width / 2, r.height / 2, view.scale * f); }, fit: function () { fitView(); draw(); }, catalog: function () { return catalog; }, layer: function (k, on, md) { if (k in layerOn) layerOn[k] = !!on; if (md && k in layerMode) layerMode[k] = md; renderLayers(); paintProgress(); draw(); }, hitsAt: function () { return hits.map(function (ht) { return { x: ht.x, y: ht.y, title: ht.title, sub: ht.sub }; }); }, fog: function (on, player) { layerOn.fog = !!on; fogPlayer = player || ''; fogCache = {}; renderLayers(); draw(); }, perf: function () { return { viewAt: perf.viewAt, sharpAt: perf.sharpAt, draws: perf.draws, tiles: tileOrder.length }; }, canvas: function () { return canvas; } };
		window.wgcViewer = api;   // the last mounted viewer, for the harnesses
		return api;
	}

	window.DimraethCompass = { mount: mount };
})();
