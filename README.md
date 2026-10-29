# GreenVibe（原创、免费）

这是一个原创的 Emby / Jellyfin 播放器原型，用 Electron + mpv 的思路做的。
界面走清爽明亮风：大留白、大海报墙、简单顶部导航、绿色点缀、奇异果图标，
风格灵感仅为“干净清爽”这一通用方向，不复制任何第三方客户端的素材、截图或代码。
它只走 Emby / Jellyfin 的公开 API，不复制、不破解任何付费客户端，
也不提供影视内容——只连你自己的服务器。

## 这个原型能做什么

V1：
- 多服务器管理（增、删、切换），多线路切换
- 媒体库浏览：电影、剧集、继续观看、最新添加
- 详情页（海报走 Emby 图片接口）、单服务器搜索
- 播放：直连优先、转码备用，选片源 / 版本、选音轨
- 断点续播：读服务器的观看进度，提示继续；播放时上报进度，跨设备靠服务器进度同步
- 字幕：服务器内嵌 / 外挂字幕、本地字幕文件、双字幕叠加、字号 / 位置 / 颜色可调

V2：
- 聚合搜索、聚合视界（多个非私密服务器汇总）
- 下一集预加载 + 自动播下一集
- 手动跳过片头片尾 + 记住片头结束点
- 外部播放器（PotPlayer / VLC，需本机已装；mpv 已内置，见打包说明）
- 视频下载 / 磁盘缓存（服务器允许时）
- 弹幕叠加：可配弹幕来源 URL，也支持本地弹幕文件（不内置任何盗版弹幕源）
- Trakt 同步设置（填你自己的 Client ID / Token，不内置 key）
- WebDAV 备份 / 还原设置（写到你自己的 WebDAV）
- 私密服务器开关、mpv 播放、Anime4K shader 路径设置、HDR 色调映射开关

## 小白快速看一眼（不用装任何东西）

1. 在电脑上找到这个文件夹里的 `renderer/index.html`，双击用浏览器打开。
2. 打开后先勾选顶部的“演示模式”，首页就能看到演示电影和剧集，点开能播演示视频。
3. 演示模式只是看界面，不连真服务器。

## 在 Windows 上用 Electron 跑（推荐）

1. 电脑上先装好 Node.js（官网下载，一路下一步）。
2. 在这个文件夹里打开命令行（地址栏输 `cmd` 回车），依次运行：
   ```
   npm install
   npm start
   ```
3. 打开后在“设置 / 服务器”里填：
   - 服务器地址，例如 `http://192.168.1.10:8096`
   - 用户名、密码（直接在 App 里填，不要发给任何人）
   - 点“添加并登录”，成功后去“首页 / 媒体库”就能看。
4. 播放默认用内置 mpv：点播放器里的“用内置 mpv 播放”就行，不用另外装 mpv。
   设置里的 mpv 路径留空就是内置 mpv，只有想用自己装的 mpv 时才填。
   没有内置 mpv（例如只在网页预览里打开）时，也能先用浏览器内置播放器看，
   格式受限时请换片源或走服务器转码。

## 在 Windows 上一键打包出 .exe（小白版）

仓库里已经加好了打包配置（electron-builder，Windows x64，产品名 GreenVibe），
还有一个一键脚本，步骤就是：

1. 在 Windows 电脑上先装好 Node.js（官网下载，一路下一步）。
2. 把这个仓库下载到电脑上（GitHub 页面点 Code → Download ZIP，解压），
   图标文件 `icon.png` 就在仓库根目录，`build/icon.ico` 是打包用的图标。
3. 双击仓库根目录里的 `build-windows.bat`，等它跑完，不要中途关窗口。
   它会先跑 `npm install`，再下载并校验内置 mpv（约 34 MB 下载、解压后约 116 MB），
   然后再跑打包，成功后会直接在窗口里告诉你 exe 在哪。
4. 打包成功后，产物在 `dist` 文件夹里：
   - 绿色免安装版：`dist\GreenVibe.exe`，双击就能打开，不用安装；
   - 如果绿色版失败，脚本会自动改打解压文件夹版：`dist\win-unpacked\GreenVibe.exe`，
     同样双击就能打开。
5. 打开后在“设置 / 服务器”里填你自己的服务器地址、用户名、密码就能看。

手动打包也可以（和一键脚本做的是同一件事）：
```
npm install
npm run dist:win
```
只想打解压文件夹版，就跑 `npm run pack:win`。

重要说明：打包版默认用内置 mpv，不用你另外装 mpv。内置 mpv 的来源要说清楚：
mpv 本身不提供官方第一方 Windows 安装包，mpv.io 安装页列出的是第三方构建，
本项目用的是其中第一行列出的 shinchiro 构建（GitHub shinchiro/mpv-winbuild-cmake），
一键脚本会下载 20261021 版并校验 SHA256 再解压进包里，设置里的 mpv 路径是可选的，
只有想用自己装的 mpv 时才填。内置 mpv 解压后约 116 MB，所以最后的 exe/文件夹会比较大，
这是正常的。Anime4K 同理：需要你自己提供 shader 文件路径。
注意：内置 mpv 文件（resources/mpv/mpv.exe，约 116 MB）体积大，不会通过 GitHub
文本推送上传，仓库里只有下载它的脚本和配置；你在 Windows 上双击脚本时它才会下载。

为什么这里没有直接给你一个现成的 exe 下载链接：本机是 Linux、没有 wine，
在这里打 Windows 包最后一步签名会失败（见下面“本地打包尝试”），
虽然产出了一个可用的 win-unpacked 文件夹（约 380 MB，含内置 mpv），
但它没有上传到 GitHub（GitHub 文本推送不接受二进制、也不适合传 380 MB），
所以可靠的办法还是上面这套在你 Windows 电脑上双击脚本的流程，
在 Windows 上通常能直接产出单文件绿色版。

## 本地打包尝试（Linux 本机，实测结果）

- 环境：Linux，Node 24.22.1，electron-builder 25.1.8，Electron 31.7.7，本地没有 wine。
- `npm install` 成功（405 个包）。
- `npx electron-builder --win dir --x64`：打包步骤本身完成了，产出了
  `dist/win-unpacked/GreenVibe.exe`（173 MB，PE32+ Windows GUI），
  `resources/app.asar` 里含 main.js、preload.js、renderer/index.html、renderer/app.js、
  renderer/style.css、icon.png，`resources/mpv/mpv.exe`（116 MB，SHA256 与下载的
  shinchiro 20261021 版一致）也在包里，说明内置 mpv 确实打进去了；
  整个 win-unpacked 文件夹约 380 MB。
  但最后一步报了错，退出码 1，原因是 electron-builder 在签名步骤要调用
  signtool.exe，需要 wine，而本机没有 wine：`wine is required` /
  `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`。这个错不影响上面那个已产出的
  win-unpacked 文件夹在 Windows 上双击运行（未签名，Windows 可能会弹安全提示，
  点“仍要运行”即可），但它不是一个“完全成功”的构建。
- `npx electron-builder --win portable`：在同一台 Linux 上同样在签名步骤因缺 wine
  失败，没有产出单独的绿色版 GreenVibe.exe，只有上面那个 win-unpacked。
  在真正的 Windows 电脑上不需要 wine，绿色版通常能正常产出，这也是
  build-windows.bat 先试 portable、失败再改打 dir 的原因。
- 结论：本地 Linux 只能验证“打包内容正确、内置 mpv 在包里”，
  不能在这里交出一个官方签名的单文件 exe；想要单文件绿色版，
  请在 Windows 上双击 build-windows.bat。

## 诚实说明（先说清楚，免得失望）

- 服务器端的硬件转码、DVR 录制，取决于你自己的 Emby 服务器有没有开、
  有没有付费，换个客户端变不出来。
- 自动识别片头片尾，需要服务器装片头检测插件；没有插件时，
  本原型只提供手动跳过 + 记住片头结束点。
- 弹幕、Trakt、WebDAV 都要你自己提供来源 / 账号，本原型不内置来源和密钥。
- 账号密码、token 只存在你本机浏览器 / Electron 本地存储里，
  只发给你的服务器，不会发给作者。
