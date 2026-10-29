// app.js —— 原创渲染逻辑，走公开 Emby/Jellyfin REST API
// 安全原则：服务器地址、账号、token 只存本机 localStorage，只发给用户自己的服务器。
// 不内置任何第三方客户端代码、密钥、弹幕源、Trakt key。
(function () {
  'use strict';
  var LS_SERVERS = 'greenvibe.servers';
  var LS_SETTINGS = 'greenvibe.settings';
  var LS_SKIP = 'greenvibe.skipPoints';

  function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; } }
  function saveJson(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  var state = {
    servers: loadJson(LS_SERVERS, []),
    settings: Object.assign({ mpvPath: '', anime4kPath: '', hdr: false, extPlayerPath: '', danmakuUrl: '', skipIntroSec: 85, subSize: 22, subBottom: 60, subColor: '#ffffff', traktClientId: '', traktToken: '', webdavUrl: '', webdavUser: '', webdavPass: '' }, loadJson(LS_SETTINGS, {})),
    skipPoints: loadJson(LS_SKIP, {}),
    demo: false,
    newLines: [],
    favorites: loadJson('greenvibe.favorites', []),
    currentServerIndex: 0,
    currentItem: null,
    currentSources: [],
    currentSourceIndex: 0,
    nextEpisode: null,
    nextPreloaded: null,
    playbackMode: 'direct',
    hlsTried: false,
    playStallTimer: null,
    netSpeedTimer: null,
    lastBufferedEnd: 0,
    usingMpv: false,
    primaryCues: [], secondaryCues: [], danmakuItems: [],
    progressTimer: null,
    sessionId: 'greenvibe-' + Math.random().toString(36).slice(2, 10)
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ticksToSec(t) { return (t || 0) / 10000000; }
  function secToTicks(s) { return Math.round((s || 0) * 10000000); }

  // ---------- 演示数据：不用服务器也能看界面 ----------
  var DEMO_ITEMS = [
    { Id: 'demo-m1', Name: '演示电影：星空之下', Type: 'Movie', ProductionYear: 2024, Overview: '这是一条演示数据，用来在没有服务器时看界面。连上真服务器后会被真数据替换。', UserData: { PlaybackPositionTicks: secToTicks(1234) }, MediaSources: [{ Id: 'ms1', Name: '1080p', MediaStreams: [{ Type: 'Video', Codec: 'h264' }, { Type: 'Audio', Codec: 'aac', Language: '中文' }] }], demoVideo: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
    { Id: 'demo-s1', Name: '演示剧集：第 1 集', Type: 'Episode', SeriesName: '演示剧集', ParentIndexNumber: 1, IndexNumber: 1, Overview: '演示剧集单集。', UserData: {}, MediaSources: [{ Id: 'ms2', Name: '720p', MediaStreams: [] }], demoVideo: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
    { Id: 'demo-s2', Name: '演示剧集：第 2 集', Type: 'Episode', SeriesName: '演示剧集', ParentIndexNumber: 1, IndexNumber: 2, Overview: '下一集演示，播放第 1 集时会预加载这一集的信息。', UserData: {}, MediaSources: [{ Id: 'ms3', Name: '720p', MediaStreams: [] }], demoVideo: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' }
  ];

  function currentServer() {
    var s = state.servers[state.currentServerIndex];
    if (!s) return null;
    // 多线路：当前线路 URL 优先
    var lines = s.lines || [];
    var url = s.url;
    if (typeof s.activeLine === 'number' && lines[s.activeLine]) url = lines[s.activeLine];
    return Object.assign({}, s, { baseUrl: String(url).replace(/\/$/, '') });
  }

  function authHeader(server) {
    var token = server.token || server.apiKey || '';
    return 'MediaBrowser Client="GreenVibe", Device="Windows", DeviceId="' + state.sessionId + '", Version="0.1.0"' + (token ? ', Token="' + token + '"' : '');
  }

  async function api(server, path, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(server.baseUrl + path, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'X-Emby-Authorization': authHeader(server), 'Content-Type': 'application/json' }, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error('网络连接失败（服务器连不上）：请检查主机、端口、加密开关和网络，再点“测试连接”');
    }
    var text = await res.text();
    if (!res.ok) {
      var plain = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (res.status === 401) throw new Error('用户名或密码不对（服务器返回 401）' + (plain ? '：' + plain : ''));
      if (res.status === 404) throw new Error('服务器地址不对，找不到这个接口（服务器返回 404）：请检查主机、路径和端口');
      throw new Error('服务器返回 ' + res.status + (plain ? '：' + plain : '') + '（接口：' + path + '）');
    }
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  // ---- 服务器地址拼装（SenPlayer 式：主机 / 路径 / 端口 / 加密开关）----
  function composeServerUrl(host, pathPart, port, httpsOn) {
    var h = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!h) return '';
    // 如果用户在主机里顺手粘了路径，把路径拆出来
    var slash = h.indexOf('/');
    var extraPath = '';
    if (slash >= 0) { extraPath = h.slice(slash); h = h.slice(0, slash); }
    var pp = String(pathPart || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pp && extraPath) pp = extraPath.replace(/^\/+/, '').replace(/\/+$/, '');
    var proto = httpsOn ? 'https' : 'http';
    var portPart = String(port || '').trim();
    return proto + '://' + h + (portPart ? ':' + portPart : '') + (pp ? '/' + pp : '');
  }
  function parseFullUrl(url) {
    var u = String(url || '').trim();
    if (!u) return { host: '', path: '', port: '', https: false };
    if (!/^https?:\/\//.test(u)) u = 'http://' + u;
    try {
      // URL 解析会把默认端口（http 的 80、https 的 443）归一化为空，这里先用正则把用户明确写的端口抢回来，保证粘贴 http://line.xmsl.org:80 后仍显示 80。
      var portMatch = u.match(/:\/\/[^/:]+:(\d+)(\/|$)/);
      var parsed = new URL(u);
      return { host: parsed.hostname, path: parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, ''), port: (portMatch && portMatch[1]) || parsed.port || '', https: parsed.protocol === 'https:' };
    } catch (e) { return { host: u, path: '', port: '', https: false }; }
  }
  function typeLabel(t) {
    if (t === 'Movie') return '电影';
    if (t === 'Series') return '剧集';
    if (t === 'Episode') return '剧集单集';
    return t || '';
  }
  function setLoginStatus(text, kind) {
    var el = $('modalLoginStatus'); if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function renderBackupLines() {
    var list = $('srvModalLinesList'); if (!list) return;
    list.innerHTML = '';
    state.newLines.forEach(function (l, i) {
      var d = document.createElement('div'); d.className = 'line-item';
      var span = document.createElement('span'); span.textContent = l;
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn-soft'; del.textContent = '删除';
      del.onclick = function () { state.newLines.splice(i, 1); renderBackupLines(); };
      d.appendChild(span); d.appendChild(del); list.appendChild(d);
    });
    var c = $('srvModalLinesCount'); if (c) c.textContent = state.newLines.length + ' 条';
  }
  function syncUrlPreview() {
    var url = composeServerUrl($('srvModalHost').value, $('srvModalPath').value, $('srvModalPort').value, $('srvModalHttps').checked);
    if ($('srvModalUrlPreview')) $('srvModalUrlPreview').value = url;
    return url;
  }

  function imageUrl(server, item, type) {
    if (!server) return '';
    return server.baseUrl + '/Items/' + item.Id + '/Images/' + (type || 'Primary') + '?maxWidth=400&api_key=' + encodeURIComponent(server.token || server.apiKey || '');
  }

  // 海报兜底链：主海报 Primary -> 缩略图 Thumb -> 背景图 Backdrop -> 最后才显示片名文字。
  // img 标签发不出 X-Emby-Authorization 头，所以仍用 api_key 查询参数 + 该影片所属服务器的地址/令牌。
  window.gvPosterFallback = function (img) {
    var steps = ['Primary', 'Thumb', 'Backdrop'];
    var step = parseInt(img.dataset.step || '0', 10);
    if (step >= steps.length - 1) {
      var parent = img.parentNode;
      img.remove();
      if (parent) parent.textContent = img.dataset.name || '';
      return;
    }
    img.dataset.step = String(step + 1);
    img.src = img.dataset.base + '/Items/' + img.dataset.itemId + '/Images/' + steps[step + 1] + '?maxWidth=400&api_key=' + encodeURIComponent(img.dataset.token || '');
  };

  // 宽卡（16:9）用的兜底链与竖海报不同：先试横向缩略图 Thumb，再试背景图 Backdrop，最后才试主海报 Primary。
  window.gvWideFallback = function (img) {
    var steps = ['Thumb', 'Backdrop', 'Primary'];
    var step = parseInt(img.dataset.step || '0', 10);
    if (step >= steps.length - 1) {
      var parent = img.parentNode;
      img.remove();
      if (parent) parent.textContent = img.dataset.name || '';
      return;
    }
    img.dataset.step = String(step + 1);
    img.src = img.dataset.base + '/Items/' + img.dataset.itemId + '/Images/' + steps[step + 1] + '?maxWidth=640&api_key=' + encodeURIComponent(img.dataset.token || '');
  };

  // Emby 有的接口返回 {Items:[...]}，有的（如 Latest）直接返回数组，统一归一化。
  function itemsFrom(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.Items)) return data.Items;
    return [];
  }
  function setStatus(id, text) {
    var el = $(id); if (el) el.textContent = text || '';
  }

  function renderGrid(el, items, server, emptyText) {
    if (!el) return;
    el.innerHTML = '';
    (items || []).forEach(function (it) {
      // 聚合列表里每部片可能来自不同服务器：海报和详情必须用它自己的服务器，
      // 不能一律用当前选中的服务器，否则跨服务器的海报会 404 / 错图。
      var itemServer = it._server || server;
      var div = document.createElement('div');
      div.className = 'card';
      var posterDiv = document.createElement('div');
      posterDiv.className = 'poster';
      if (it.demoVideo) {
        posterDiv.textContent = it.Name;
      } else if (itemServer) {
        var img = document.createElement('img');
        img.src = imageUrl(itemServer, it, 'Primary');
        img.alt = '';
        img.dataset.base = itemServer.baseUrl;
        img.dataset.itemId = it.Id;
        img.dataset.token = itemServer.token || itemServer.apiKey || '';
        img.dataset.name = it.Name || '';
        img.dataset.step = '0';
        img.onerror = function () { window.gvPosterFallback(img); };
        posterDiv.appendChild(img);
      } else {
        posterDiv.textContent = it.Name;
      }
      if (it.CommunityRating) {
        var badge = document.createElement('span');
        badge.className = 'rating-badge';
        badge.textContent = Number(it.CommunityRating).toFixed(1);
        posterDiv.appendChild(badge);
      }
      var pos = it.UserData && it.UserData.PlaybackPositionTicks ? ' · 已看 ' + Math.round(ticksToSec(it.UserData.PlaybackPositionTicks) / 60) + ' 分钟' : '';
      var meta = document.createElement('div');
      meta.className = 'meta';
      // 海报卡：标题在上、年份在下（无年份时退回类型），评分以右下角徽标显示在海报上。
      meta.innerHTML = '<b>' + esc(it.Name) + '</b><br><small>' + (it.ProductionYear ? esc(it.ProductionYear) : esc(typeLabel(it.Type))) + pos + '</small>';
      div.appendChild(posterDiv);
      div.appendChild(meta);
      div.onclick = function () { openDetail(it, itemServer); };
      el.appendChild(div);
    });
    if (!items || !items.length) {
      // 已登录真服务器时不再说“演示开关/先登录”这种误导话；只有没登录时才提示去登录。
      el.innerHTML = '<p class="hint">' + esc(emptyText || (server && server.token ? '这个分类下还没有内容。' : '还没有添加服务器，请先添加并登录。')) + '</p>';
    }
  }

  // ---------- 分类（Views / 媒体库）----------
  // GET /Users/{userId}/Views：Emby/Jellyfin 的媒体库分类（电影、剧集、音乐等）。
  // 按服务器分别存，换服务器不串台；两种返回形状都兼容。
  async function loadViews(srv) {
    var raw = state.servers[state.currentServerIndex];
    if (!raw || !raw.token) return [];
    if (raw.views && raw.views.length) return raw.views;
    var data = await api(srv, '/Users/' + srv.userId + '/Views');
    var views = itemsFrom(data).map(function (v) { return { Id: v.Id, Name: v.Name, CollectionType: v.CollectionType || '' }; });
    raw.views = views;
    saveJson(LS_SERVERS, state.servers);
    return views;
  }
  function populateLibCategory(views) {
    var sel = $('libCategory'); if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    var all = document.createElement('option'); all.value = ''; all.textContent = '全部'; sel.appendChild(all);
    (views || []).forEach(function (v) {
      var o = document.createElement('option'); o.value = v.Id; o.textContent = v.Name; sel.appendChild(o);
    });
    if (prev && (views || []).some(function (v) { return v.Id === prev; })) sel.value = prev;
  }
  function viewNameById(views, id) {
    var v = (views || []).filter(function (x) { return x.Id === id; })[0];
    return v ? v.Name : '';
  }
  function goToLibraryCategory(viewId) {
    var sel = $('libCategory'); if (sel) sel.value = viewId || '';
    switchTab('library');
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h ? String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    return h ? h + ':' + mm : mm;
  }
  function makeWideImg(itemServer, item, startType) {
    var img = document.createElement('img');
    img.src = imageUrl(itemServer, item, startType);
    img.alt = '';
    img.dataset.base = itemServer.baseUrl;
    img.dataset.itemId = item.Id;
    img.dataset.token = itemServer.token || itemServer.apiKey || '';
    img.dataset.name = item.Name || '';
    img.dataset.step = '0';
    return img;
  }
  // 首页顶部：继续观看宽卡（16:9 横卡，海报/背景图 + 集数信息 + 进度条 + 已看/总时长）。
  function renderResumeWide(el, items, server) {
    if (!el) return;
    el.innerHTML = '';
    (items || []).forEach(function (it) {
      var itemServer = it._server || server;
      var card = document.createElement('div');
      card.className = 'wide-card';
      if (it.demoVideo) {
        card.textContent = it.Name;
      } else if (itemServer) {
        var img = makeWideImg(itemServer, it, 'Thumb');
        img.onerror = function () { window.gvWideFallback(img); };
        card.appendChild(img);
      } else {
        card.textContent = it.Name;
      }
      var title = it.SeriesName || it.Name;
      var ep = '';
      if (it.Type === 'Episode' && it.ParentIndexNumber != null && it.IndexNumber != null) {
        ep = 'S' + String(it.ParentIndexNumber).padStart(2, '0') + ' · E' + String(it.IndexNumber).padStart(2, '0') + ' · ' + it.Name;
      } else if (it.SeriesName) {
        ep = it.Name;
      }
      var posTicks = it.UserData && it.UserData.PlaybackPositionTicks;
      var runTicks = it.RunTimeTicks;
      var pct = (posTicks && runTicks) ? Math.min(100, Math.round(posTicks / runTicks * 100)) : 0;
      var timeText = (posTicks && runTicks) ? fmtClock(ticksToSec(posTicks)) + ' / ' + fmtClock(ticksToSec(runTicks)) : (posTicks ? '已看 ' + Math.round(ticksToSec(posTicks) / 60) + ' 分钟' : '');
      var overlay = document.createElement('div');
      overlay.className = 'wide-overlay';
      overlay.innerHTML = '<b>' + esc(title) + '</b>' + (ep ? '<br><small>' + esc(ep) + '</small>' : '') + (timeText ? '<br><small>▶ ' + esc(timeText) + '</small>' : '');
      card.appendChild(overlay);
      if (posTicks && runTicks) {
        var bar = document.createElement('div');
        bar.className = 'wide-progress';
        var fill = document.createElement('i');
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
      }
      card.onclick = function () { openDetail(it, itemServer); };
      el.appendChild(card);
    });
    if (!items || !items.length) el.innerHTML = '<p class="hint">' + (server && server.token ? '还没有继续观看的内容。' : '还没有添加服务器，请先添加并登录。') + '</p>';
  }
  // 首页“我的媒体”：每库一张 16:9 宽卡。先试库自己的主图，没有时用该库前 4 部片的海报拼一张拼贴卡。
  function renderMyMedia(el, views, srv, counts, collages) {
    if (!el) return;
    el.innerHTML = '';
    (views || []).forEach(function (view) {
      var card = document.createElement('div');
      card.className = 'wide-card';
      var visual = document.createElement('div');
      visual.style.position = 'absolute';
      visual.style.inset = '0';
      card.appendChild(visual);
      var buildCollage = function () {
        visual.innerHTML = '';
        var collage = document.createElement('div');
        collage.className = 'lib-collage';
        (collages[view.Id] || []).slice(0, 4).forEach(function (item) {
          var img = makeWideImg(srv, item, 'Primary');
          img.onerror = function () { window.gvPosterFallback(img); };
          collage.appendChild(img);
        });
        if (!collage.children.length) collage.textContent = view.Name;
        visual.appendChild(collage);
      };
      var own = document.createElement('img');
      own.src = srv.baseUrl + '/Items/' + view.Id + '/Images/Primary?maxWidth=640&api_key=' + encodeURIComponent(srv.token || srv.apiKey || '');
      own.alt = '';
      own.onerror = buildCollage;
      visual.appendChild(own);
      var overlay = document.createElement('div');
      overlay.className = 'wide-overlay';
      overlay.innerHTML = '<b>' + esc(view.Name) + '</b>';
      card.appendChild(overlay);
      card.onclick = function () { goToLibraryCategory(view.Id); };
      el.appendChild(card);
    });
    if (!views || !views.length) el.innerHTML = '<p class="hint">服务器没有返回任何分类（媒体库为空，或这个账号没有访问任何媒体库的权限）。</p>';
  }

  // ---------- 服务器管理 ----------
  function refreshServerUI() {
    var sel = $('serverSelect'); sel.innerHTML = '';
    state.servers.forEach(function (s, i) {
      var o = document.createElement('option'); o.value = i; o.textContent = s.name + (s.private ? '（私密）' : ''); sel.appendChild(o);
    });
    sel.value = state.currentServerIndex;
    var lineSel = $('lineSelect'); lineSel.innerHTML = '';
    var srv = state.servers[state.currentServerIndex];
    var lines = (srv && srv.lines) || [];
    if (!lines.length) { var o0 = document.createElement('option'); o0.textContent = '默认线路'; lineSel.appendChild(o0); }
    lines.forEach(function (l, i) { var o = document.createElement('option'); o.value = i; o.textContent = l; lineSel.appendChild(o); });
    if (srv) lineSel.value = (typeof srv.activeLine === 'number' ? srv.activeLine : '');
    var list = $('serverList'); list.innerHTML = '';
    if (!state.servers.length) list.innerHTML = '<p class="hint">还没有添加服务器，请在上面填好后点“添加并登录”。</p>';
    state.servers.forEach(function (s, i) {
      var d = document.createElement('div'); d.className = 'server-item';
      var info = document.createElement('div');
      info.innerHTML = '<b>' + esc(s.name) + '</b>' + (s.remark ? ' · ' + esc(s.remark) : '') + '<br><small>' + esc(s.url) + (s.private ? '（私密）' : '') + (s.lines && s.lines.length ? ' · 备用线路 ' + s.lines.length + ' 条' : '') + '</small>';
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn-soft'; del.textContent = '删除'; del.onclick = function () { state.servers.splice(i, 1); saveJson(LS_SERVERS, state.servers); refreshServerUI(); };
      d.appendChild(info); d.appendChild(del); list.appendChild(d);
    });
    renderBackupLines();
    // 设置页回填
    $('mpvPath').value = state.settings.mpvPath || '';
    $('anime4kPath').value = state.settings.anime4kPath || '';
    $('hdrToggle').checked = !!state.settings.hdr;
    $('extPlayerPath').value = state.settings.extPlayerPath || '';
    $('danmakuUrl').value = state.settings.danmakuUrl || '';
    $('skipIntroSec').value = state.settings.skipIntroSec || 85;
    $('subSize').value = state.settings.subSize || 22;
    $('subBottom').value = state.settings.subBottom || 60;
    $('subColor').value = state.settings.subColor || '#ffffff';
    $('traktClientId').value = state.settings.traktClientId || '';
    $('traktToken').value = state.settings.traktToken || '';
    $('webdavUrl').value = state.settings.webdavUrl || '';
    $('webdavUser').value = state.settings.webdavUser || '';
    $('webdavPass').value = state.settings.webdavPass || '';
    applySubtitleStyle();
  }

  function applySubtitleStyle() {
    var p = $('subPrimary'), s = $('subSecondary');
    [p, s].forEach(function (el) { el.style.fontSize = (state.settings.subSize || 22) + 'px'; el.style.color = state.settings.subColor || '#ffffff'; });
    p.style.bottom = (state.settings.subBottom || 60) + 'px';
    s.style.bottom = ((state.settings.subBottom || 60) + 40) + 'px';
  }

  function saveSettingsFromForm() {
    state.settings.mpvPath = $('mpvPath').value || '';
    state.settings.anime4kPath = $('anime4kPath').value || '';
    state.settings.hdr = $('hdrToggle').checked;
    state.settings.extPlayerPath = $('extPlayerPath').value || '';
    state.settings.danmakuUrl = $('danmakuUrl').value || '';
    state.settings.skipIntroSec = Number($('skipIntroSec').value) || 85;
    state.settings.subSize = Number($('subSize').value) || 22;
    state.settings.subBottom = Number($('subBottom').value) || 60;
    state.settings.subColor = $('subColor').value || '#ffffff';
    state.settings.traktClientId = $('traktClientId').value || '';
    state.settings.traktToken = $('traktToken').value || '';
    state.settings.webdavUrl = $('webdavUrl').value || '';
    state.settings.webdavUser = $('webdavUser').value || '';
    state.settings.webdavPass = $('webdavPass').value || '';
    saveJson(LS_SETTINGS, state.settings);
    applySubtitleStyle();
  }

  async function loginServer(srv) {
    if (srv.apiKey) { srv.token = srv.apiKey; return srv; }
    var server = Object.assign({}, srv, { baseUrl: String(srv.url).replace(/\/$/, '') });
    var data = await api(server, '/Users/AuthenticateByName', { method: 'POST', body: { Username: srv.username, Pw: srv.password } });
    srv.userId = data.User && data.User.Id;
    srv.token = data.AccessToken;
    return srv;
  }

  // ---------- 浏览 / 搜索 ----------
  async function loadHome() {
    if (state.demo) {
      setStatus('homeStatus', '演示模式：下面是演示数据，连上真服务器后会被真数据替换。');
      renderResumeWide($('resumeWide'), DEMO_ITEMS.filter(function (x) { return x.UserData && x.UserData.PlaybackPositionTicks; }), null);
      if ($('myMediaGrid')) $('myMediaGrid').innerHTML = '<p class="hint">演示模式：连上真服务器后，这里会显示你的媒体库宽卡。</p>';
      if ($('homeViews')) $('homeViews').innerHTML = '';
      return;
    }
    var srv = currentServer();
    if (!srv || !srv.token) {
      setStatus('homeStatus', '还没有添加服务器，请先添加并登录。');
      renderResumeWide($('resumeWide'), [], srv);
      if ($('myMediaGrid')) $('myMediaGrid').innerHTML = '';
      if ($('homeViews')) $('homeViews').innerHTML = '';
      return;
    }
    // 继续观看 + 最新（最新只供聚合视界页用；首页不再单设一个全局“最新添加”排，
    // 避免和下面每库一排的最新内容重复）。
    var resumeAll = [], latestAll = [], homeErrors = [];
    for (var i = 0; i < state.servers.length; i++) {
      var s0 = state.servers[i]; if (s0.private) continue;
      var sv = Object.assign({}, s0, { baseUrl: String(s0.url).replace(/\/$/, '') });
      try {
        var r = await api(sv, '/Users/' + sv.userId + '/Items/Resume?Limit=10&Fields=PrimaryImageAspectRatio,Overview,ProductionYear,CommunityRating');
        var l = await api(sv, '/Users/' + sv.userId + '/Items/Latest?Limit=10&Fields=PrimaryImageAspectRatio,Overview,ProductionYear,CommunityRating');
        itemsFrom(r).forEach(function (x) { x._server = sv; resumeAll.push(x); });
        itemsFrom(l).forEach(function (x) { x._server = sv; latestAll.push(x); });
      } catch (e) { homeErrors.push((s0.name || '服务器') + '：' + e.message); }
    }
    renderResumeWide($('resumeWide'), resumeAll, srv);
    if ($('aggResumeGrid')) renderGrid($('aggResumeGrid'), resumeAll, srv, '还没有继续观看的内容。');
    if ($('aggLatestGrid')) renderGrid($('aggLatestGrid'), latestAll, srv, '还没有最新添加的内容。');

    // 分类 + 每库总数 + 拼贴素材：先取 Views，再逐库取前 4 部（一次查询同时拿到
    // TotalRecordCount 总数和拼贴海报），这样“我的媒体”宽卡和每库标题里的总数都有据可依。
    var views = [], viewErr = '', counts = {}, collages = {}, viewErrors = [];
    try {
      views = await loadViews(srv);
      populateLibCategory(views);
    } catch (e) { viewErr = e.message; }
    for (var vi = 0; vi < views.length; vi++) {
      try {
        var head = await api(srv, '/Users/' + srv.userId + '/Items?ParentId=' + encodeURIComponent(views[vi].Id) + '&Recursive=true&Limit=4&Fields=PrimaryImageAspectRatio,Overview,ProductionYear,Genres,CommunityRating&SortBy=SortName');
        var headItems = itemsFrom(head);
        counts[views[vi].Id] = (head && typeof head.TotalRecordCount === 'number') ? head.TotalRecordCount : headItems.length;
        collages[views[vi].Id] = headItems.map(function (x) { x._server = srv; return x; });
      } catch (e) {
        counts[views[vi].Id] = 0;
        collages[views[vi].Id] = [];
        viewErrors.push(views[vi].Name + '：' + e.message);
      }
    }
    var totalItems = 0;
    Object.keys(counts).forEach(function (k) { totalItems += counts[k] || 0; });
    var countBtn = $('myMediaCountBtn');
    if (countBtn) {
      countBtn.textContent = views.length + ' >';
      countBtn.onclick = function () { goToLibraryCategory(''); };
    }
    renderMyMedia($('myMediaGrid'), views, srv, counts, collages);

    // 每库一节：标题 = 库名 + 总数 + '>'（点标题箭头进该分类的媒体库），
    // 下面是该库的竖海报横排：先取 Latest 15 部，空了回退到递归 Items 15 部。
    var homeViewsEl = $('homeViews');
    if (homeViewsEl) {
      homeViewsEl.innerHTML = '';
      views.forEach(function (view) {
        var section = document.createElement('div');
        var headRow = document.createElement('div');
        headRow.className = 'section-head home-section-head';
        var title = document.createElement('h2'); title.textContent = view.Name; headRow.appendChild(title);
        var arrow = document.createElement('button');
        arrow.className = 'count-arrow btn-soft'; arrow.type = 'button';
        arrow.textContent = (counts[view.Id] || 0) + ' >';
        arrow.onclick = function () { goToLibraryCategory(view.Id); };
        headRow.appendChild(arrow);
        section.appendChild(headRow);
        var grid = document.createElement('div'); grid.className = 'poster-row'; section.appendChild(grid);
        homeViewsEl.appendChild(section);
        (async function () {
          var items = [];
          try {
            var lat = await api(srv, '/Users/' + srv.userId + '/Items/Latest?ParentId=' + encodeURIComponent(view.Id) + '&Limit=15&Fields=PrimaryImageAspectRatio,Overview,ProductionYear,Genres,CommunityRating');
            items = itemsFrom(lat);
            if (!items.length) {
              var lst = await api(srv, '/Users/' + srv.userId + '/Items?ParentId=' + encodeURIComponent(view.Id) + '&Recursive=true&Limit=15&Fields=PrimaryImageAspectRatio,Overview,ProductionYear,Genres,CommunityRating&SortBy=SortName');
              items = itemsFrom(lst);
              if (lst && typeof lst.TotalRecordCount === 'number' && counts[view.Id] === 0) {
                counts[view.Id] = lst.TotalRecordCount;
                arrow.textContent = counts[view.Id] + ' >';
              }
            }
          } catch (e) {
            grid.innerHTML = '<p class="hint">这个分类加载失败：' + esc(e.message) + '</p>';
            return;
          }
          items.forEach(function (x) { x._server = srv; });
          renderGrid(grid, items, srv, '这个分类下还没有内容。');
        })();
      });
    }
    var errText = homeErrors.concat(viewErrors).join('；');
    if (viewErr) {
      setStatus('homeStatus', '分类加载失败：' + viewErr + (errText ? '；' + errText : ''));
    } else if (!views.length) {
      setStatus('homeStatus', '服务器没有返回任何分类（媒体库为空，或这个账号没有访问任何媒体库的权限）。' + (errText ? '；' + errText : ''));
    } else {
      setStatus('homeStatus', '已加载 ' + views.length + ' 个分类，' + totalItems + ' 部影片' + (errText ? '；部分分类加载失败：' + errText : ''));
    }
  }

  async function loadLibrary() {
    if (state.demo) { setStatus('libStatus', '演示模式：下面是演示数据。'); renderGrid($('libGrid'), DEMO_ITEMS, null); return; }
    var srv = currentServer(); if (!srv || !srv.token) { setStatus('libStatus', '还没有添加服务器，请先添加并登录。'); renderGrid($('libGrid'), [], srv); return; }
    // 先取分类并填充下拉框，分类失败也要把原因报出来，而不是静默显示旧的“全部”。
    var views = [];
    try { views = await loadViews(srv); } catch (e) { setStatus('libStatus', '分类加载失败：' + e.message + '，先按“全部”显示。'); }
    populateLibCategory(views);
    var type = $('libType').value;
    var category = $('libCategory') ? $('libCategory').value : '';
    var q;
    if (category) {
      q = '/Users/' + srv.userId + '/Items?ParentId=' + encodeURIComponent(category) + '&Recursive=true&Limit=100&Fields=PrimaryImageAspectRatio,Overview,ProductionYear,Genres,CommunityRating&SortBy=SortName' + (type ? '&IncludeItemTypes=' + type : '');
    } else {
      q = '/Users/' + srv.userId + '/Items?Recursive=true&Limit=50&Fields=PrimaryImageAspectRatio,Overview,ProductionYear&SortBy=SortName' + (type ? '&IncludeItemTypes=' + type : '');
    }
    try {
      var data = await api(srv, q);
      var items = itemsFrom(data);
      renderGrid($('libGrid'), items, srv, '这个分类下还没有内容。');
      setStatus('libStatus', '已加载 ' + items.length + ' 部影片' + (category ? '（分类：' + viewNameById(views, category) + '）' : '（分类：全部）'));
    } catch (e) {
      setStatus('libStatus', '加载失败：' + e.message);
      $('libGrid').innerHTML = '<p class="hint">加载失败：' + esc(e.message) + '</p>';
    }
  }

  async function doSearch(aggregated) {
    var term = $('searchInput').value.trim(); if (!term) return;
    if (state.demo) { renderGrid($('searchGrid'), DEMO_ITEMS.filter(function (x) { return x.Name.indexOf(term) >= 0; }), null); return; }
    var targets = aggregated ? state.servers.filter(function (s) { return !s.private; }) : [state.servers[state.currentServerIndex]];
    var all = [];
    for (var i = 0; i < targets.length; i++) {
      var sv = Object.assign({}, targets[i], { baseUrl: String(targets[i].url).replace(/\/$/, '') });
      if (!sv.token) continue;
      try { var d = await api(sv, '/Users/' + sv.userId + '/Items?Recursive=true&SearchTerm=' + encodeURIComponent(term) + '&Limit=30&Fields=PrimaryImageAspectRatio,Overview'); (d.Items || []).forEach(function (x) { x._server = sv; all.push(x); }); } catch (e) {}
    }
    renderGrid($('searchGrid'), all, currentServer());
  }

  // ---------- 详情 ----------
  function openDetail(item, server) {
    state.currentItem = item;
    var srv = server || currentServer();
    var body = $('detailBody');
    var poster = item.demoVideo ? '' : '<img src="' + esc(imageUrl(srv, item)) + '" style="max-width:240px" data-base="' + esc(srv ? srv.baseUrl : '') + '" data-item-id="' + esc(item.Id) + '" data-token="' + esc(srv ? (srv.token || srv.apiKey || '') : '') + '" data-name="' + esc(item.Name) + '" data-step="0" onerror="window.gvPosterFallback(this)">';
    body.innerHTML = poster + '<h2>' + esc(item.Name) + '</h2><p>' + esc(item.Overview || '暂无简介') + '</p>' +
      '<p>类型：' + esc(typeLabel(item.Type)) + (item.ProductionYear ? ' · ' + item.ProductionYear : '') + '</p>' +
      '<button id="detailPlay">▶ 播放</button> <button id="detailResume">从上次位置继续</button> <button id="detailFav" class="btn-soft">' + (state.favorites.some(function (x) { return x.Id === item.Id; }) ? '已收藏，点击取消' : '收藏') + '</button>';
    $('detailModal').classList.remove('hidden');
    $('detailPlay').onclick = function () { $('detailModal').classList.add('hidden'); startPlayback(item, srv, 0); };
    $('detailResume').onclick = function () { $('detailModal').classList.add('hidden'); startPlayback(item, srv, ticksToSec(item.UserData && item.UserData.PlaybackPositionTicks)); };
    $('detailFav').onclick = function () {
      var idx = state.favorites.findIndex(function (x) { return x.Id === item.Id; });
      if (idx >= 0) state.favorites.splice(idx, 1); else state.favorites.push({ Id: item.Id, Name: item.Name, Type: item.Type, ProductionYear: item.ProductionYear, Overview: item.Overview });
      saveJson('greenvibe.favorites', state.favorites); renderFavorites();
      this.textContent = state.favorites.some(function (x) { return x.Id === item.Id; }) ? '已收藏，点击取消' : '收藏';
    };
  }

  // ---------- 字幕解析：SRT / VTT ----------
  function parseTimecode(tc) {
    var m = tc.trim().match(/(\d+):(\d+):([\d.,]+)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3].replace(',', '.'));
  }
  function parseSubtitleText(text) {
    var cues = [];
    var blocks = text.replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n/, '').split(/\n\s*\n/);
    blocks.forEach(function (b) {
      var lines = b.trim().split('\n'); if (!lines.length) return;
      var ti = lines.findIndex(function (l) { return l.indexOf('-->') >= 0; });
      if (ti < 0) return;
      var times = lines[ti].split('-->');
      cues.push({ start: parseTimecode(times[0]), end: parseTimecode(times[1]), text: lines.slice(ti + 1).join('<br>') });
    });
    return cues;
  }
  function cueAt(cues, t) {
    for (var i = 0; i < cues.length; i++) { if (t >= cues[i].start && t <= cues[i].end) return cues[i].text; }
    return '';
  }

  // ---------- 弹幕解析：JSON [{time,text}] 或 B站 XML <d p="秒,..."> ----
  function parseDanmakuText(text) {
    try { var j = JSON.parse(text); if (Array.isArray(j)) return j.map(function (x) { return { time: Number(x.time || x.t || 0), text: String(x.text || x.m || '') }; }); } catch (e) {}
    var items = [];
    var re = /<d p="([\d.]+)[^"]*">([^<]+)<\/d>/g, m;
    while ((m = re.exec(text)) !== null) items.push({ time: Number(m[1]), text: m[2] });
    return items;
  }

  // ---------- 播放 ----------
  async function fetchPlaybackInfo(item, server) {
    if (item.demoVideo) return { MediaSources: item.MediaSources || [], demoVideo: item.demoVideo };
    var info = await api(server, '/Items/' + item.Id + '/PlaybackInfo', { method: 'POST', body: { UserId: server.userId, MaxStreamingBitrate: 120000000 } });
    return info;
  }

  function streamUrl(item, server, source, direct) {
    if (item.demoVideo) return item.demoVideo;
    var base = server.baseUrl;
    // 守卫：片源缺失时绝不能抛错（以前 source.Id 在 source 为 undefined 时会抛，
    // mpv/外部播放器/下载按钮拿到的就是 MediaSourceId=undefined 的坏地址）。
    var ms = (source && source.Id) ? '&MediaSourceId=' + encodeURIComponent(source.Id) : '';
    if (direct) return base + '/Videos/' + item.Id + '/stream?Static=true' + ms + '&api_key=' + encodeURIComponent(server.token || '');
    return base + '/Videos/' + item.Id + '/master.m3u8?' + (ms ? ms.slice(1) + '&' : '') + 'api_key=' + encodeURIComponent(server.token || '');
  }
  function hlsUrl(item, server, source) {
    if (item.demoVideo) return item.demoVideo;
    var ms = (source && source.Id) ? 'MediaSourceId=' + encodeURIComponent(source.Id) + '&' : '';
    return server.baseUrl + '/Videos/' + item.Id + '/master.m3u8?' + ms + 'VideoCodec=h264&AudioCodec=aac&api_key=' + encodeURIComponent(server.token || '');
  }
  function currentSource() {
    // 永远默认第 0 个片源：startPlayback 会把 currentSourceIndex 复位为 0，
    // 避免上一部片选了第 2 个片源、下一部片只有 1 个片源时取到 undefined。
    return state.currentSources[state.currentSourceIndex] || state.currentSources[0] || {};
  }
  function sourceCodecText(src) {
    if (!src || !src.Id) return '（服务器没有返回片源信息）';
    var streams = src.MediaStreams || [];
    var v = streams.filter(function (x) { return x.Type === 'Video'; })[0];
    var a = streams.filter(function (x) { return x.Type === 'Audio'; })[0];
    return '容器 ' + (src.Container || '未知') + ' · 视频 ' + (v ? (v.Codec || '未知') : (src.VideoCodec || '未知')) + ' · 音频 ' + (a ? (a.Codec || '未知') : '未知');
  }
  function setPlayerStatus(text, kind) {
    var el = $('playerStatus'); if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function clearPlayWatchdog() { if (state.playStallTimer) { clearTimeout(state.playStallTimer); state.playStallTimer = null; } }
  // ---------- 播放网速显示（浏览器内置播放时） ----------
  // 原理（诚实说明）：浏览器 <video> 不直接给下载速度，所以这里用
  // “每秒缓冲末尾增长的秒数 × 片源平均码率”来估算。码率来自 Emby
  // MediaSources 的 Bitrate（比特/秒）；没有码率时不编造 MB/s，
  // 只显示“缓冲增长 X.X 秒/秒（估算）”。mpv/外部播放器是独立进程，
  // GreenVibe 拿不到它的网速，那时只写一句提示，不编数字。
  function setNetSpeed(text) { var el = $('netSpeed'); if (el) el.textContent = text || ''; }
  function fmtSpeed(bytesPerSec) {
    if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1024) return Math.round(bytesPerSec / 1024) + ' KB/s';
    return Math.round(bytesPerSec) + ' B/s';
  }
  function currentBitrate() {
    var src = currentSource();
    if (src && Number(src.Bitrate) > 0) return Number(src.Bitrate); // 比特/秒
    return 0;
  }
  function stopNetSpeedTimer() { if (state.netSpeedTimer) { clearInterval(state.netSpeedTimer); state.netSpeedTimer = null; } }
  function startNetSpeedTimer() {
    stopNetSpeedTimer();
    if (state.usingMpv) { setNetSpeed('已交给 mpv/外部播放器播放，网速请看播放器窗口。'); return; }
    var video = $('videoEl'); if (!video) return;
    state.lastBufferedEnd = video.buffered && video.buffered.length ? video.buffered.end(video.buffered.length - 1) : (video.currentTime || 0);
    state.netSpeedTimer = setInterval(function () {
      var v = $('videoEl'); if (!v || !state.currentItem || state.usingMpv) { stopNetSpeedTimer(); return; }
      var end = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : (v.currentTime || 0);
      var bufferedAhead = Math.max(0, end - (v.currentTime || 0));
      var growth = end - state.lastBufferedEnd;
      state.lastBufferedEnd = end;
      if (v.paused) { setNetSpeed('已暂停 · 已缓冲 ' + Math.round(bufferedAhead) + ' 秒'); return; }
      var bufferedText = '已缓冲 ' + Math.round(bufferedAhead) + ' 秒';
      if (growth <= 0.05 && bufferedAhead < 5 && v.readyState < 3) { setNetSpeed('缓冲中… · ' + bufferedText); return; }
      var bitrate = currentBitrate();
      if (bitrate > 0) {
        var bytes = Math.max(0, growth) * bitrate / 8;
        setNetSpeed('网速：' + fmtSpeed(bytes) + ' · ' + bufferedText);
      } else {
        setNetSpeed('网速（估算）：缓冲增长 ' + Math.max(0, growth).toFixed(1) + ' 秒/秒 · ' + bufferedText);
      }
    }, 1000);
  }
  function describeVideoError(video) {
    var e = video.error;
    if (!e) return '浏览器没有给出具体错误代码';
    if (e.code === 1) return '播放被中断（错误 1）';
    if (e.code === 2) return '网络错误，流地址拿不到数据（错误 2，可能是 404/401 或反代没转发）';
    if (e.code === 3) return '解码失败（错误 3，浏览器解不开这个编码，最常见是 HEVC / 10-bit / DTS / MKV）';
    if (e.code === 4) return '浏览器不支持这个视频源（错误 4，容器或编码不受支持）';
    return '浏览器视频错误（代码 ' + e.code + '）' + (e.message ? '：' + e.message : '');
  }
  function tryHlsFallback(reason) {
    var item = state.currentItem, srv = currentServer();
    if (!item || state.demo || state.hlsTried) return false;
    state.hlsTried = true; state.playbackMode = 'hls';
    var video = $('videoEl');
    setPlayerStatus('浏览器直连播不出来（' + reason + '），正在自动换转码流（HLS，H.264 + AAC）再试一次…如果转码流也黑屏，请点上面绿色的“用内置 mpv 播放”。', 'loading');
    video.src = hlsUrl(item, srv, currentSource());
    video.play().catch(function (e) { setPlayerStatus('转码流也被浏览器拒绝：' + (e && e.message ? e.message : '未知原因') + '，请点上面绿色的“用内置 mpv 播放”。', 'error'); });
    startPlayWatchdog();
    startNetSpeedTimer();
    return true;
  }
  function startPlayWatchdog() {
    clearPlayWatchdog();
    state.playStallTimer = setTimeout(function () {
      var video = $('videoEl');
      if (!video || video.readyState >= 3 || video.currentTime > 0 || !state.currentItem) return;
      if (!tryHlsFallback('15 秒内一直没有画面，疑似卡住')) {
        setPlayerStatus('播放一直没有画面：' + describeVideoError(video) + '。浏览器两种流都试过了，请点上面绿色的“用内置 mpv 播放”（mpv 能解 HEVC / DTS / MKV），或检查服务器网络。', 'error');
      }
    }, 15000);
  }
  function handleVideoError() {
    stopNetSpeedTimer();
    setNetSpeed('播放出错，网速停止统计。');
    var video = $('videoEl');
    var reason = describeVideoError(video);
    if (!tryHlsFallback(reason)) {
      setPlayerStatus('浏览器播不出来：' + reason + '。这通常是片源编码浏览器不支持（HEVC / 10-bit / DTS / MKV 很常见），请点上面绿色的“用内置 mpv 播放”——mpv 能解这些编码；也可以换一个片源再试。', 'error');
    }
  }

  async function preloadNextEpisode(item, server) {
    state.nextEpisode = null; state.nextPreloaded = null;
    if (item.Type !== 'Episode' || !item.SeriesId) return;
    try {
      var list = await api(server, '/Users/' + server.userId + '/Items?ParentId=' + item.SeriesId + '&Recursive=true&IncludeItemTypes=Episode&Fields=IndexNumber,ParentIndexNumber&SortBy=IndexNumber');
      var eps = list.Items || [];
      var idx = eps.findIndex(function (x) { return x.Id === item.Id; });
      if (idx >= 0 && eps[idx + 1]) {
        state.nextEpisode = eps[idx + 1];
        state.nextPreloaded = await fetchPlaybackInfo(eps[idx + 1], server); // 预加载下一集播放信息
      }
    } catch (e) {}
    // 演示模式：按演示数组找下一集
    if (state.demo) {
      var di = DEMO_ITEMS.findIndex(function (x) { return x.Id === item.Id; });
      if (di >= 0 && DEMO_ITEMS[di + 1]) { state.nextEpisode = DEMO_ITEMS[di + 1]; state.nextPreloaded = { demoVideo: DEMO_ITEMS[di + 1].demoVideo }; }
    }
  }

  async function startPlayback(item, server, startSeconds) {
    state.currentItem = item;
    // 关键修复：每部片都从第 0 个片源开始，否则上一部片的片源序号会带到下一部片，
    // mpv / 外部播放器 / 下载按钮就会拿到 currentSources[undefined]，拼出 MediaSourceId=undefined 的坏地址。
    state.currentSourceIndex = 0;
    state.hlsTried = false;
    state.playbackMode = 'direct';
    state.usingMpv = false;
    stopNetSpeedTimer();
    setNetSpeed('');
    clearPlayWatchdog();
    var srv = server || currentServer();
    var video = $('videoEl');
    $('playerTitle').textContent = item.Name || '播放中';
    $('playerModal').classList.remove('hidden');
    setPlayerStatus('正在获取片源…', 'loading');
    try {
      var info = await fetchPlaybackInfo(item, srv);
      state.currentSources = info.MediaSources || item.MediaSources || [];
      if (!state.currentSources.length) { setPlayerStatus('播放失败：服务器没有返回可用片源（MediaSources 为空），请检查这部片在服务器上是否可播、账号是否有权限。', 'error'); return; }
      var sel = $('sourceSelect'); sel.innerHTML = '';
      state.currentSources.forEach(function (s, i) { var o = document.createElement('option'); o.value = i; o.textContent = s.Name || ('片源 ' + (i + 1)); sel.appendChild(o); });
      var audioSel = $('audioSelect'); audioSel.innerHTML = '';
      var audios = (state.currentSources[0] && state.currentSources[0].MediaStreams || []).filter(function (x) { return x.Type === 'Audio'; });
      audios.forEach(function (a, i) { var o = document.createElement('option'); o.value = i; o.textContent = (a.DisplayTitle || a.Codec || '音轨') + (a.Language ? ' · ' + a.Language : ''); audioSel.appendChild(o); });
      // 字幕轨
      var subs = (state.currentSources[0] && state.currentSources[0].MediaStreams || []).filter(function (x) { return x.Type === 'Subtitle'; });
      var fillSub = function (el) { el.innerHTML = '<option value="">无</option>'; subs.forEach(function (s, i) { var o = document.createElement('option'); o.value = i; o.textContent = (s.DisplayTitle || s.Codec || '字幕') + (s.Language ? ' · ' + s.Language : ''); el.appendChild(o); }); };
      fillSub($('subPrimarySelect')); fillSub($('subSecondarySelect'));
      state.currentSubs = subs;
      var src = state.currentSources[0];
      var url = info.demoVideo || streamUrl(item, srv, src, true);
      video.src = url;
      try { video.currentTime = startSeconds || 0; } catch (e) {}
      video.play().catch(function (e) { setPlayerStatus('浏览器播放被拒绝：' + (e && e.message ? e.message : '未知原因') + '，请点上面绿色的“用内置 mpv 播放”。', 'error'); });
      startPlayWatchdog();
      startNetSpeedTimer();
      setPlayerStatus('正在用浏览器直连播放：' + (src.Name || '片源 1') + '（' + sourceCodecText(src) + '）。浏览器只擅长 H.264 + AAC，HEVC / 10-bit / DTS / MKV 很可能黑屏；播不出来会自动换转码流，仍不行请点上面绿色的“用内置 mpv 播放”。', 'loading');
      await preloadNextEpisode(item, srv);
      if (state.nextEpisode) $('playerStatus').textContent += ' · 下一集已预加载：' + state.nextEpisode.Name;
      // 弹幕来源
      if (state.settings.danmakuUrl) { try { var dt = await (await fetch(state.settings.danmakuUrl)).text(); state.danmakuItems = parseDanmakuText(dt); } catch (e) {} }
      // 进度上报：每 10 秒 + 暂停/关闭时上报
      clearInterval(state.progressTimer);
      state.progressTimer = setInterval(function () { reportProgress(false); }, 10000);
    } catch (e) {
      setPlayerStatus('播放失败：' + e.message + '（请先点“测试连接”确认服务器通，再点上面绿色的“用内置 mpv 播放”试一次）。', 'error');
    }
  }

  async function reportProgress(stopped) {
    var video = $('videoEl'); var item = state.currentItem; var srv = currentServer();
    if (!item || state.demo || !srv || !srv.token) return;
    try {
      await api(srv, '/Sessions/Playing/' + (stopped ? 'Stopped' : 'Progress'), { method: 'POST', body: { ItemId: item.Id, PositionTicks: secToTicks(video.currentTime || 0), IsPaused: video.paused } });
    } catch (e) {}
  }

  function closePlayer() {
    var video = $('videoEl');
    reportProgress(true);
    clearPlayWatchdog();
    stopNetSpeedTimer();
    setNetSpeed('');
    state.usingMpv = false;
    clearInterval(state.progressTimer);
    video.pause(); video.removeAttribute('src'); video.load();
    $('playerModal').classList.add('hidden');
  }

  function renderFavorites() {
    if (!$('favGrid')) return;
    var items = state.favorites || [];
    if (!items.length) { $('favGrid').innerHTML = '<p class="hint">还没有收藏。去首页或媒体库点开一部片，点“收藏”就会出现在这里。</p>'; return; }
    renderGrid($('favGrid'), items, currentServer());
  }
  function switchTab(tab) {
    document.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('[data-tab="' + tab + '"]').forEach(function (x) { x.classList.add('active'); });
    var el = $('tab-' + tab); if (el) el.classList.add('active');
    if (tab === 'home') loadHome();
    if (tab === 'favorites') renderFavorites();
    if (tab === 'aggregate') loadHome();
    if (tab === 'library') loadLibrary();
    if (tab === 'servers') refreshServerUI();
  }

  // ---------- 事件绑定 ----------
  document.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { switchTab(b.dataset.tab); }; });
  $('topSearchBtn').onclick = function () { $('searchInput').value = $('topSearchInput').value; switchTab('search'); doSearch(false); };
  $('topSearchInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { $('searchInput').value = this.value; switchTab('search'); doSearch(false); } });
  $('heroAddServerBtn').onclick = function () { openServerModal(); };
  $('openServerModalBtn').onclick = function () { openServerModal(); };
  $('serverSelect').onchange = function () { state.currentServerIndex = Number(this.value); refreshServerUI(); loadHome(); };
  $('lineSelect').onchange = function () {
    var srv = state.servers[state.currentServerIndex]; if (!srv) return;
    srv.activeLine = Number(this.value); saveJson(LS_SERVERS, state.servers); refreshServerUI(); loadHome();
  };
  $('demoToggle').onchange = function () { state.demo = this.checked; loadHome(); loadLibrary(); };
  $('refreshLib').onclick = loadLibrary;
  if ($('libCategory')) $('libCategory').onchange = loadLibrary;
  if ($('libType')) $('libType').onchange = loadLibrary;
  $('searchBtn').onclick = function () { doSearch(false); };
  $('aggSearchBtn').onclick = function () { doSearch(true); };
  $('detailClose').onclick = function () { $('detailModal').classList.add('hidden'); };
  $('playerClose').onclick = closePlayer;

  function readServerForm() {
    var url = syncUrlPreview();
    if (!url && $('srvModalUrl').value.trim()) {
      var parsed = parseFullUrl($('srvModalUrl').value.trim());
      $('srvModalHost').value = parsed.host; $('srvModalPath').value = parsed.path; $('srvModalPort').value = parsed.port; $('srvModalHttps').checked = parsed.https;
      url = syncUrlPreview();
    }
    return { name: $('srvModalName').value.trim() || '影视服务器', remark: $('srvModalRemark').value.trim(), url: url, username: $('srvModalUser').value.trim(), password: $('srvModalPass').value, apiKey: $('srvModalApiKey').value.trim(), private: $('srvModalPrivate').checked, lines: state.newLines.slice(), activeLine: 0 };
  }
  function bindServerFormSync() {
    // 注意：这里以前写错了控件 ID（srvHost/srvPath/srvPort 根本不存在），
    // 第一个不存在的控件一调 addEventListener 就会抛错，整个脚本在
    // “测试连接 / 登录”按钮绑定之前就中断了，所以点按钮完全没反应。
    // 修法：用弹窗里真实的 ID，并且每个控件先判空，缺一个也不能拖垮登录按钮。
    ['srvModalHost', 'srvModalPath', 'srvModalPort'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('input', syncUrlPreview); });
    var httpsEl = $('srvModalHttps'); if (httpsEl) httpsEl.addEventListener('change', syncUrlPreview);
    var urlEl = $('srvModalUrl'); if (urlEl) urlEl.addEventListener('input', function () {
      var parsed = parseFullUrl(this.value.trim());
      if (parsed.host) { $('srvModalHost').value = parsed.host; $('srvModalPath').value = parsed.path; $('srvModalPort').value = parsed.port; $('srvModalHttps').checked = parsed.https; syncUrlPreview(); }
    });
    var lineBtn = $('srvModalLineAddBtn'); if (lineBtn) lineBtn.onclick = function () {
      var v = $('srvModalLineInput').value.trim(); if (!v) return;
      if (!/^https?:\/\//.test(v)) v = 'http://' + v;
      state.newLines.push(v); $('srvModalLineInput').value = ''; renderBackupLines();
    };
    var passT = $('srvModalPassToggle'); if (passT) passT.onclick = function () { var el = $('srvModalPass'); el.type = el.type === 'password' ? 'text' : 'password'; };
    var traktT = $('traktTokenToggle'); if (traktT) traktT.onclick = function () { var el = $('traktToken'); el.type = el.type === 'password' ? 'text' : 'password'; };
    var davT = $('webdavPassToggle'); if (davT) davT.onclick = function () { var el = $('webdavPass'); el.type = el.type === 'password' ? 'text' : 'password'; };
  }
  function openServerModal() { setLoginStatus('', ''); $('serverModal').classList.remove('hidden'); renderBackupLines(); syncUrlPreview(); }
  function closeServerModal() { $('serverModal').classList.add('hidden'); }
  $('serverModalClose').onclick = closeServerModal;
  $('modalCancelBtn').onclick = closeServerModal;
  $('serverModal').addEventListener('click', function (e) { if (e.target === this) closeServerModal(); });
  try { bindServerFormSync(); } catch (e) { console.error('服务器表单绑定失败（登录按钮仍会继续绑定）：', e); }
  $('modalTestBtn').onclick = async function () {
    var srv = readServerForm();
    if (!srv.url) { setLoginStatus('请先填主机和端口，例如主机 line.xmsl.org、端口 80。', 'error'); return; }
    setLoginStatus('正在测试连接…', 'loading');
    try {
      var server = Object.assign({}, srv, { baseUrl: srv.url });
      var info = await api(server, '/System/Info/Public');
      setLoginStatus('连接成功：服务器名称 ' + (info.ServerName || '未知') + '，版本 ' + (info.Version || '未知') + '。接下来可以点“添加并登录”。', 'success');
    } catch (e) { setLoginStatus('服务器连不上：' + e.message + '。请先检查主机、端口和加密开关是否和你平时用的完全一致。', 'error'); }
  };
  $('modalLoginBtn').onclick = async function () {
    var btn = $('modalLoginBtn');
    var srv = readServerForm();
    if (!srv.url) { setLoginStatus('请先填主机和端口，例如主机 line.xmsl.org、端口 80。', 'error'); return; }
    if (!srv.apiKey && !srv.username) { setLoginStatus('请先填用户名，或者填密钥（可选）。', 'error'); return; }
    btn.disabled = true; var oldText = btn.textContent; btn.textContent = '正在登录…';
    setLoginStatus('正在登录…', 'loading');
    try {
      await loginServer(srv);
      state.servers.push(srv); saveJson(LS_SERVERS, state.servers); state.currentServerIndex = state.servers.length - 1; state.newLines = [];
      refreshServerUI(); closeServerModal(); setLoginStatus('登录成功，已添加服务器“' + srv.name + '”。', 'success'); loadHome();
    } catch (e) { setLoginStatus('登录失败：' + e.message + '。请检查用户名和密码是否和你平时用的完全一致（区分大小写），也可以先点“测试连接”确认服务器本身通不通。', 'error'); }
    btn.disabled = false; btn.textContent = oldText;
  };
  if ($('saveServersBtn')) $('saveServersBtn').onclick = function () { saveSettingsFromForm(); setLoginStatus('设置已保存到本机（还没有登录，点“添加并登录”才会验证账号）。', 'success'); };
  $('topSaveBtn').onclick = function () { saveSettingsFromForm(); setLoginStatus('已保存。', 'success'); };

  // 播放器控制
  $('resumeBtn').onclick = function () { var item = state.currentItem; if (item && item.UserData) $('videoEl').currentTime = ticksToSec(item.UserData.PlaybackPositionTicks); };
  $('skipIntroBtn').onclick = function () { $('videoEl').currentTime += (state.settings.skipIntroSec || 85); };
  $('markIntroBtn').onclick = function () { var item = state.currentItem; if (!item) return; state.skipPoints[item.Id] = $('videoEl').currentTime; saveJson(LS_SKIP, state.skipPoints); $('playerStatus').textContent = '已把当前位置记为该片的片头结束，下次点“跳过片头”会跳到这里。'; };
  // 注意：上面 mark 后，跳过按钮仍按秒数；若已记点，优先跳到记点
  $('skipIntroBtn').addEventListener('click', function () {
    var item = state.currentItem; if (item && state.skipPoints[item.Id] != null) $('videoEl').currentTime = state.skipPoints[item.Id];
  });
  $('skipOutroBtn').onclick = function () { var v = $('videoEl'); if (v.duration) v.currentTime = Math.max(0, v.duration - 30); };
  $('nextEpBtn').onclick = function () { if (state.nextEpisode) { var srv = currentServer(); closePlayer(); startPlayback(state.nextEpisode, srv, 0); } else { alert('没有下一集，或下一集还没加载出来'); } };
  $('sourceSelect').onchange = function () {
    var item = state.currentItem; var srv = currentServer(); var idx = Number(this.value); state.currentSourceIndex = idx;
    var src = state.currentSources[idx]; if (!src) return;
    state.hlsTried = false; state.playbackMode = 'direct';
    var v = $('videoEl'); var t = v.currentTime; v.src = streamUrl(item, srv, src, true); try { v.currentTime = t; } catch (e) {}
    v.play().catch(function (e) { setPlayerStatus('浏览器播放被拒绝：' + (e && e.message ? e.message : '未知原因') + '，请点上面绿色的“用内置 mpv 播放”。', 'error'); });
    startPlayWatchdog();
    setPlayerStatus('已换片源：' + (src.Name || '') + '（' + sourceCodecText(src) + '），正在用浏览器直连播放。', 'loading');
  };
  $('mpvBtn').onclick = async function () {
    var item = state.currentItem; var srv = currentServer(); var v = $('videoEl');
    if (!item || !srv) { setPlayerStatus('还没有可播的片，请先点一部片再点 mpv。', 'error'); return; }
    if (!window.electronAPI) { setPlayerStatus('网页预览模式没有 mpv 桥接，请在 Electron 里打开本应用再点这个按钮。', 'error'); return; }
    var src = currentSource();
    if (!src.Id && !item.demoVideo) { setPlayerStatus('mpv 拿不到片源（服务器没有返回 MediaSource），请先重新点这部片再试。', 'error'); return; }
    // 先停掉浏览器内置播放和网速统计，避免 mpv 和浏览器同时出声/抢带宽；
    // 状态先写“正在启动”，成功/失败在 IPC 返回后才写，绝不在 mpv 退出后才报成功。
    try { v.pause(); } catch (e) {}
    stopNetSpeedTimer();
    setPlayerStatus('正在启动 mpv…（' + (src.Name || '') + '，' + sourceCodecText(src) + '）', 'loading');
    setNetSpeed('正在启动 mpv…');
    var res = await window.electronAPI.playMpv({ url: streamUrl(item, srv, src, true), startSeconds: Math.floor(v.currentTime || 0), mpvPath: state.settings.mpvPath, anime4kShader: state.settings.anime4kPath, hdrToneMapping: state.settings.hdr, title: item.Name });
    if (res.ok) {
      state.usingMpv = true;
      setPlayerStatus('mpv 已启动（独立窗口播放中，关闭 mpv 窗口后回到这里）。如果没有看到 mpv 窗口，请检查它是否被本应用窗口挡住、或在任务栏里。', 'success');
      setNetSpeed('已交给 mpv 播放，网速请看播放器窗口。');
    } else {
      state.usingMpv = false;
      setPlayerStatus('mpv 启动失败：' + res.error + '（内置 mpv 没找到时，请在设置里填自己装的 mpv 路径，或用浏览器转码流先看）', 'error');
      setNetSpeed('mpv 启动失败，网速停止统计。');
    }
  };
  $('extBtn').onclick = async function () {
    var item = state.currentItem; var srv = currentServer(); var src = currentSource();
    var url = streamUrl(item, srv, src, true);
    if (!window.electronAPI) { try { await navigator.clipboard.writeText(url); $('playerStatus').textContent = '已把播放地址复制到剪贴板，请粘贴到 PotPlayer / VLC 里打开。'; } catch (e) { $('playerStatus').textContent = '播放地址：' + url; } return; }
    try { $('videoEl').pause(); } catch (e) {}
    stopNetSpeedTimer();
    var res = await window.electronAPI.launchExternal({ exePath: state.settings.extPlayerPath, url: url });
    $('playerStatus').textContent = res.ok ? '已交给外部播放器' : '外部播放器启动失败：' + res.error;
    if (res.ok) { state.usingMpv = true; setNetSpeed('已交给外部播放器播放，网速请看播放器窗口。'); }
  };
  $('downloadBtn').onclick = async function () {
    var item = state.currentItem; var srv = currentServer(); var src = currentSource();
    var url = streamUrl(item, srv, src, true);
    if (window.electronAPI) { var res = await window.electronAPI.downloadVideo({ url: url, filename: (item.Name || 'video') + '.mp4' }); $('playerStatus').textContent = res.ok ? '已开始下载到：' + res.path : '下载失败：' + res.error; }
    else { var a = document.createElement('a'); a.href = url; a.download = (item.Name || 'video') + '.mp4'; a.click(); $('playerStatus').textContent = '已触发浏览器下载（服务器允许时才有效）。'; }
  };

  // 字幕：主/次选择（从服务器取字幕文件并做自定义叠加显示）
  async function loadSubtitleTrack(index, isSecondary) {
    var item = state.currentItem; var srv = currentServer(); var src = currentSource();
    var sub = (state.currentSubs || [])[index]; if (!sub) { if (isSecondary) state.secondaryCues = []; else state.primaryCues = []; return; }
    try {
      // Emby 字幕流地址：优先用 DeliveryUrl，否则按常见格式拼
      var url = sub.DeliveryUrl ? srv.baseUrl + sub.DeliveryUrl : srv.baseUrl + '/Videos/' + item.Id + '/' + src.Id + '/Subtitles/' + sub.Index + '/0/Stream.' + (sub.Codec || 'srt') + '?api_key=' + encodeURIComponent(srv.token || '');
      var text = await (await fetch(url)).text();
      var cues = parseSubtitleText(text);
      if (isSecondary) state.secondaryCues = cues; else state.primaryCues = cues;
    } catch (e) { $('playerStatus').textContent = '字幕加载失败：' + e.message; }
  }
  $('subPrimarySelect').onchange = function () { loadSubtitleTrack(Number(this.value), false); };
  $('subSecondarySelect').onchange = function () { loadSubtitleTrack(Number(this.value), true); };
  $('localSubFile').onchange = async function () {
    var f = this.files[0]; if (!f) return;
    var text = await f.text(); state.primaryCues = parseSubtitleText(text);
    $('playerStatus').textContent = '已加载本地字幕：' + f.name + '（作为主字幕显示）';
  };
  $('localDanmakuFile').onchange = async function () {
    var f = this.files[0]; if (!f) return;
    var text = await f.text(); state.danmakuItems = parseDanmakuText(text);
    $('playerStatus').textContent = '已加载本地弹幕：' + f.name + '，共 ' + state.danmakuItems.length + ' 条';
  };

  // 视频时间更新：字幕 + 弹幕
  var lastDanmakuSecond = -1;
  $('videoEl').addEventListener('timeupdate', function () {
    var t = this.currentTime;
    $('subPrimary').innerHTML = cueAt(state.primaryCues, t);
    $('subSecondary').innerHTML = cueAt(state.secondaryCues, t);
    var sec = Math.floor(t);
    if (sec !== lastDanmakuSecond) {
      lastDanmakuSecond = sec;
      state.danmakuItems.filter(function (d) { return Math.floor(d.time) === sec; }).slice(0, 5).forEach(function (d) {
        var el = document.createElement('div'); el.className = 'danmaku'; el.textContent = d.text; el.style.top = (Math.random() * 60) + '%'; el.style.animationDuration = '8s'; el.style.opacity = '0.9';
        $('danmakuLayer').appendChild(el); setTimeout(function () { el.remove(); }, 8500);
      });
    }
  });
  $('videoEl').addEventListener('ended', function () { if (state.nextEpisode) { var srv = currentServer(); closePlayer(); startPlayback(state.nextEpisode, srv, 0); } });
  // 播放诊断：以前这里没有任何 error 监听，play() 的错误又被 .catch(()=>{}) 吞掉，
  // 所以失败时就是一块黑屏、0:00、没有任何提示。现在错误会先写进播放器状态栏，
  // 直连失败自动换一次 HLS 转码流，两种都失败才提示用 mpv。
  $('videoEl').addEventListener('error', function () { if (state.currentItem) handleVideoError(); });
  $('videoEl').addEventListener('playing', function () { clearPlayWatchdog(); if (state.currentItem && !state.usingMpv) startNetSpeedTimer(); });
  $('videoEl').addEventListener('canplay', function () { clearPlayWatchdog(); });
  $('videoEl').addEventListener('pause', function () {
    if (state.usingMpv) return; // 交给 mpv 后由 mpv 按钮写外部播放提示，别被暂停事件覆盖。
    if (!state.currentItem) return;
    stopNetSpeedTimer();
    var v = $('videoEl');
    var ahead = (v.buffered && v.buffered.length) ? Math.max(0, v.buffered.end(v.buffered.length - 1) - (v.currentTime || 0)) : 0;
    setNetSpeed('已暂停 · 已缓冲 ' + Math.round(ahead) + ' 秒');
  });

  // Trakt / WebDAV：只用用户自己的凭据
  $('traktSyncBtn').onclick = async function () {
    saveSettingsFromForm();
    if (!state.settings.traktClientId || !state.settings.traktToken) { $('settingsStatus').textContent = '请先填你自己的 Trakt 客户端编号和访问令牌。'; return; }
    try {
      var res = await fetch('https://api.trakt.tv/sync/history', { method: 'GET', headers: { 'trakt-api-key': state.settings.traktClientId, 'trakt-api-version': '2', 'Authorization': 'Bearer ' + state.settings.traktToken } });
      $('settingsStatus').textContent = res.ok ? 'Trakt 连接成功（已看同步接口已通，完整同步按 Trakt 返回的历史条目处理）。' : 'Trakt 返回 ' + res.status + '，请检查客户端编号和访问令牌。';
    } catch (e) { $('settingsStatus').textContent = 'Trakt 连接失败：' + e.message; }
  };
  $('webdavBackupBtn').onclick = async function () {
    saveSettingsFromForm();
    var base = (state.settings.webdavUrl || '').replace(/\/$/, '');
    if (!base) { $('settingsStatus').textContent = '请先填 WebDAV 地址。'; return; }
    try {
      var res = await fetch(base + '/greenvibe-settings.json', { method: 'PUT', headers: { 'Authorization': 'Basic ' + btoa(state.settings.webdavUser + ':' + state.settings.webdavPass), 'Content-Type': 'application/json' }, body: JSON.stringify({ servers: state.servers, settings: state.settings }) });
      $('settingsStatus').textContent = res.ok ? '备份成功，已写到你的 WebDAV。' : '备份失败，WebDAV 返回 ' + res.status;
    } catch (e) { $('settingsStatus').textContent = '备份失败：' + e.message; }
  };
  $('webdavRestoreBtn').onclick = async function () {
    saveSettingsFromForm();
    var base = (state.settings.webdavUrl || '').replace(/\/$/, '');
    if (!base) { $('settingsStatus').textContent = '请先填 WebDAV 地址。'; return; }
    try {
      var res = await fetch(base + '/greenvibe-settings.json', { headers: { 'Authorization': 'Basic ' + btoa(state.settings.webdavUser + ':' + state.settings.webdavPass) } });
      if (!res.ok) throw new Error('WebDAV 返回 ' + res.status);
      var data = await res.json();
      state.servers = data.servers || []; state.settings = Object.assign(state.settings, data.settings || {});
      saveJson(LS_SERVERS, state.servers); saveJson(LS_SETTINGS, state.settings); refreshServerUI();
      $('settingsStatus').textContent = '还原成功。';
    } catch (e) { $('settingsStatus').textContent = '还原失败：' + e.message; }
  };

  // 初始化
  refreshServerUI();
  loadHome();
})();
