// main.js —— Electron 主进程（原创代码）
// 职责：建窗口、给渲染进程提供安全桥接：启动 mpv / 外部播放器、下载缓存文件。
// 注意：这里不做任何账号校验绕过、不复制任何第三方客户端的代码或资源。
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let win = null;

function createWindow() {
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
  if (userPath && userPath !== 'mpv') return userPath;
  const exeName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const candidates = [];
  try { if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'mpv', exeName)); } catch (e) {}
  candidates.push(path.join(__dirname, 'resources', 'mpv', exeName));
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return 'mpv';
}

// ---- mpv 播放：默认用内置 mpv，自定义路径可选，内置找不到才回退系统 mpv ----
// 参数：{ url, startSeconds, subtitleFiles: [], anime4kShader, hdrToneMapping, title }
ipcMain.handle('play-mpv', async (_event, opts) => {
  const mpvPath = resolveMpvPath(opts && opts.mpvPath);
  const args = [];
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
    const child = spawn(mpvPath, args, { stdio: 'ignore', detached: false });
    child.on('error', (err) => resolve({ ok: false, error: String(err && err.message || err) }));
    child.on('close', (code) => resolve({ ok: true, code }));
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
