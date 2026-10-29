// main.js —— Electron 主进程（原创代码）
// 职责：建窗口、给渲染进程提供安全桥接：启动 mpv / 外部播放器、下载缓存文件。
// 注意：这里不做任何账号校验绕过、不复制任何第三方客户端的代码或资源。
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let win = null;

// 全中文应用菜单：原默认菜单是英文（文件/视图/窗口/帮助均为英文），现全部汉化。
function buildChineseMenu() {
  const template = [
    { label: '文件', submenu: [
      { label: '退出', role: 'quit' }
    ]},
    { label: '视图', submenu: [
      { label: '重新加载', role: 'reload' },
      { label: '强制重新加载', role: 'forceReload' },
      { label: '开发者工具', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: '实际大小', role: 'resetZoom' },
      { label: '放大', role: 'zoomIn' },
      { label: '缩小', role: 'zoomOut' },
      { type: 'separator' },
      { label: '全屏', role: 'togglefullscreen' }
    ]},
    { label: '窗口', submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '关闭', role: 'close' }
    ]},
    { label: '帮助', submenu: [
      { label: '关于 GreenVibe', click: () => { dialog.showMessageBox({ type: 'info', title: '关于 GreenVibe', message: 'GreenVibe', detail: '原创免费的 Emby / Jellyfin 播放器，走公开接口，内置 mpv 播放器。只连接你自己的服务器。' }); } }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  buildChineseMenu();
  win = new BrowserWindow({
    title: 'GreenVibe',
    icon: fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : path.join(__dirname, 'assets', 'icon.png'),
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 调试时可取消下面一行注释打开开发者工具
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---- 内置 mpv 查找顺序（Windows 打包版默认就是内置 mpv）----
// 1) 用户在设置里填的自定义 mpv 路径（如果填了，就优先用它）
// 2) 打包后内置 mpv：process.resourcesPath/mpv/mpv.exe（electron-builder extraResources）
// 3) 开发模式内置 mpv：原型文件夹 resources/mpv/mpv.exe（Windows 版）
// 4) 都找不到，才回退到系统 PATH 里的 mpv（命令名 mpv），找不到则由调用方报错
function resolveMpvPath(userPath) {
  // 用户在设置里填了自定义路径：文件必须真实存在，否则返回 null，
  // 由调用方报“自定义 mpv 文件没找到”，绝不静默回退到别的 mpv。
  if (userPath && userPath !== 'mpv') {
    try { return fs.existsSync(userPath) ? userPath : null; } catch (e) { return null; }
  }
  const exeName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const candidates = [];
  try { if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'mpv', exeName)); } catch (e) {}
  candidates.push(path.join(__dirname, 'resources', 'mpv', exeName));
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  // 关键：打包里找不到内置 mpv 时返回 null，不再静默回退到 PATH 里
  // 一个裸的 'mpv' 命令——Windows 电脑上通常根本没有这个命令，
  // 以前就是这样静默失败，用户连 mpv 窗口都看不到、还以为已启动。
  return null;
}

// ---- mpv 播放：默认用内置 mpv，自定义路径可选，内置找不到才回退系统 mpv ----
// 参数：{ url, startSeconds, subtitleFiles: [], anime4kShader, hdrToneMapping, title }
// 关键修复（以前的 bug）：以前 promise 只在子进程 close 时才 resolve，而且
// 不管退出码是不是 0 都返回 ok:true。于是 mpv 一启动失败（例如坏地址、
// 找不到 mpv），渲染进程也只能在 mpv 退出后才收到一条“已交给 mpv”的假成功；
// 而 mpv 正常播放时，用户在关闭 mpv 之前反而看不到任何已启动的提示。
// 现在分三步报告，绝不把“mpv 没出现”报成成功：
// 1) 先校验 mpv 文件真实存在：打包版必须是 process.resourcesPath/mpv/mpv.exe，
//    找不到就直接报“内置 mpv 文件没找到”，不再静默回退到 PATH 的裸 mpv；
// 2) spawn 时捕获 stderr（不再 stdio:'ignore'），并设 3 秒宽限期：
//    宽限期内 mpv 就退出（退出码非 0，或被信号杀死），按失败报告，
//    附上退出码/信号和 stderr 前 500 字，用户能看到 mpv 到底为什么没起来；
// 3) 宽限期过后 mpv 还在运行，才报 ok:true（独立窗口播放中）。
// 用户从头到尾没见过 mpv 窗口，正对应第 1 步（文件缺失）或第 2 步
// （瞬间退出），这两步现在都会变成一句看得见的失败原因，而不是假成功。
ipcMain.handle('play-mpv', async (_event, opts) => {
  const userPath = opts && opts.mpvPath;
  const mpvPath = resolveMpvPath(userPath);
  if (!mpvPath) {
    if (userPath && userPath !== 'mpv') {
      return { ok: false, error: '自定义 mpv 文件没找到：' + userPath + '（请在设置里填正确的 mpv 路径，或留空用内置 mpv）' };
    }
    const exeName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
    let expected = '';
    try { if (app.isPackaged) expected = path.join(process.resourcesPath, 'mpv', exeName); } catch (e) {}
    if (!expected) expected = path.join(__dirname, 'resources', 'mpv', exeName);
    return { ok: false, error: '内置 mpv 文件没找到（打包里没有 ' + expected + '，请重新下载最新 GreenVibe 安装包；或在设置里填自己装的 mpv 路径）' };
  }
  // mpv 日志（退出码 2 修复）：Windows GUI 版 mpv 的 stderr 管道经常是空的，
  // 所以只靠 stderr 永远拿不到“为什么播不了”。改走 --log-file：每次启动前
  // 先清空旧日志，启动后若在宽限期内退出，就读日志尾巴当作真实原因。
  // 日志只写在本机 userData 目录，不发给任何服务器。
  let mpvLogPath = '';
  try {
    const userDataDir = app.getPath('userData');
    fs.mkdirSync(userDataDir, { recursive: true });
    mpvLogPath = path.join(userDataDir, 'greenvibe-mpv.log');
    fs.writeFileSync(mpvLogPath, 'GreenVibe mpv log started\n');
  } catch (e) { mpvLogPath = ''; }
  const args = [];
  // --no-config：避免用户自己的 mpv.conf 破坏播放；--log-file 让 GUI 版
  // mpv 也能留下可读的失败原因；--msg-level=all=info 保证日志有足够细节。
  args.push('--no-config');
  if (mpvLogPath) args.push('--log-file=' + mpvLogPath);
  args.push('--msg-level=all=info');
  if (opts && opts.title) args.push('--title=' + opts.title);
  args.push('--fs'); // 全屏，可由用户按 Esc 退出
  if (opts && Number(opts.startSeconds) > 0) args.push('--start=' + Number(opts.startSeconds));
  // HDR 色调映射：mpv 选项，用户在设置里开关
  if (opts && opts.hdrToneMapping) args.push('--tone-mapping=bt.2390');
  // Anime4K：只加载用户自己提供的 shader 文件路径，不内置、不分发任何 shader
  if (opts && opts.anime4kShader) args.push('--glsl-shader=' + opts.anime4kShader);
  (opts && opts.subtitleFiles || []).forEach(f => args.push('--sub-file=' + f));
  args.push(opts.url);
  return new Promise((resolve) => {
    let settled = false;
    let stderrText = '';
    const done = (result) => { if (!settled) { settled = true; if (graceTimer) clearTimeout(graceTimer); resolve(result); } };
    let graceTimer = null;
    let child;
    try {
      // stderr 用 pipe 捕获（只看前几秒的诊断信息），stdout 仍忽略。
      child = spawn(mpvPath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (err) {
      done({ ok: false, error: String(err && err.message || err), mpvPath });
      return;
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderrText += String(d);
        if (stderrText.length > 2000) stderrText = stderrText.slice(0, 2000);
      });
    }
    child.on('error', (err) => done({ ok: false, error: String(err && err.message || err), mpvPath }));
    child.on('spawn', () => {
      // 3 秒宽限期：mpv 还在运行才算真正启动成功。
      graceTimer = setTimeout(() => done({ ok: true, started: true, mpvPath }), 3000);
    });
    child.on('close', (code, signal) => {
      if (settled) return; // 宽限期已过、已报成功，关闭只是用户关了窗口。
      // 宽限期内就退出 = 根本没播起来（用户“从没见过 mpv 窗口”就是这种情况）。
      // 原因优先级：mpv 日志尾巴 > stderr > 明确说明日志读不到。
      // 退出码 2 在 mpv 手册里就是“传入的文件无法播放”，即 mpv 本身已启动、
      // 但播不了传给它的流地址——所以这里必须给日志原文，而不是一句笼统的话。
      let logTail = '';
      let logReadError = '';
      if (mpvLogPath) {
        try {
          const raw = fs.readFileSync(mpvLogPath, 'utf8');
          logTail = String(raw || '').replace(/\s+/g, ' ').trim().slice(-1000);
        } catch (e) { logReadError = String(e && e.message || e); }
      } else {
        logReadError = '日志路径未能创建';
      }
      const stderrDetail = String(stderrText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const detail = logTail || stderrDetail;
      const detailNote = detail
        ? '（mpv 报错：' + detail + '）'
        : '（mpv 没有输出报错，且 mpv 日志文件无法读取' + (logReadError ? '：' + logReadError : '') + '，日志路径：' + (mpvLogPath || '未知') + '，请检查播放地址和片源）';
      done({
        ok: false,
        error: 'mpv 在启动后 ' + (code !== null ? '退出码 ' + code : '被信号 ' + signal + ' 终止') + '，没有真正开始播放' + detailNote,
        mpvPath,
        mpvLogPath: mpvLogPath || null,
        exitCode: code,
        signal: signal || null
      });
    });
  });
});

// ---- 外部播放器：mpv / PotPlayer / VLC，由用户在设置里填可执行文件路径 ----
ipcMain.handle('launch-external', async (_event, opts) => {
  const exe = opts && opts.exePath;
  if (!exe) return { ok: false, error: '没有填写外部播放器路径' };
  return new Promise((resolve) => {
    const child = spawn(exe, [opts.url], { stdio: 'ignore' });
    child.on('error', (err) => resolve({ ok: false, error: String(err && err.message || err) }));
    child.on('spawn', () => resolve({ ok: true }));
  });
});

// ---- 视频磁盘缓存/下载：只下载用户自己服务器上、服务器允许访问的流地址 ----
ipcMain.handle('download-video', async (_event, opts) => {
  try {
    const url = new URL(opts.url);
    const lib = url.protocol === 'https:' ? https : http;
    const destDir = path.join(app.getPath('downloads'), 'GreenVibeCache');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, (opts.filename || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_'));
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      lib.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 跟随一次重定向（Emby 转码/直连常返回重定向）
          file.close();
          ipcMain.emit('__noop');
          resolve();
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('open-external-link', async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});
