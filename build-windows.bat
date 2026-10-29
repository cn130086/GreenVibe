@echo off
chcp 65001 >nul
REM GreenVibe Windows 一键打包脚本 —— 小白用法：双击这个文件就行，不用敲命令。
REM 要求：这台 Windows 电脑上先装好 Node.js（官网下载，一路下一步）。
REM 这个脚本会：1) 装依赖 2) 下载内置 mpv（mpv.io  listed 的 shinchiro Windows 构建，见下面说明）
REM   3) 打一个绿色免安装版 exe 4) 如果绿色版失败，改打一个解压文件夹版。
REM 内置 mpv 说明：mpv 本身不提供官方第一方 Windows 安装包，mpv.io 安装页列出的是
REM 第三方构建，本脚本用的是其中第一行列出的 shinchiro 构建（GitHub shinchiro/mpv-winbuild-cmake），
REM 版本 20261021，文件 mpv-x86_64-20261021-git-e471496c56.7z，SHA256 见脚本里的 MPV_SHA。
REM 打包后 GreenVibe 默认就用这个内置 mpv，不用你另外装 mpv；设置里的 mpv 路径是可选的，
REM 只有想用自己装的 mpv 时才填。内置 mpv 体积约 116 MB，所以最后的 exe/文件夹会比较大，这是正常的。

cd /d "%~dp0"
set MPV_URL=https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-x86_64-20261021-git-e471496c56.7z
set MPV_SHA=4a355f3e89c83fabc730d33fb4e759dfec747806ed2287b61a90d1681b83e8d3

echo [1/4] 正在安装依赖（第一次会比较慢，请耐心等，不要关窗口）...
call npm install
if errorlevel 1 (
  echo.
  echo 安装依赖失败了。请先确认 Node.js 装好了，再重新双击这个文件。
  pause
  exit /b 1
)

echo.
echo [2/4] 正在准备内置 mpv...
if exist "%~dp0resources\mpv\mpv.exe" (
  echo 已经有内置 mpv，跳过下载。
) else (
  echo 正在从 shinchiro 的 GitHub Releases 下载 mpv（约 34 MB，解压后约 116 MB）...
  mkdir "%~dp0resources\mpv" 2>nul
  powershell -NoProfile -Command "Invoke-WebRequest -Uri '%MPV_URL%' -OutFile '%TEMP%\mpv-win.7z'"
  if errorlevel 1 (
    echo.
    echo mpv 下载失败了。请检查网络，再重新双击这个文件；也可以先跳过内置 mpv，
    echo 打包后在 GreenVibe 设置里填自己装的 mpv 路径。
    pause
    exit /b 1
  )
  echo 正在校验下载文件的 SHA256...
  powershell -NoProfile -Command "$h=(Get-FileHash '%TEMP%\mpv-win.7z' -Algorithm SHA256).Hash; if ($h -ne '%MPV_SHA%') { Write-Host ('SHA256 不一致，期望 %MPV_SHA%，实际 ' + $h); exit 1 }"
  if errorlevel 1 (
    echo.
    echo mpv 文件校验失败，已停止打包，避免用到来历不明的文件。请重新双击这个文件再试一次。
    pause
    exit /b 1
  )
  echo 正在解压 mpv（需要 Windows 自带的 tar 或你装的 7-Zip，二选一）...
  mkdir "%TEMP%\mpv-extract" 2>nul
  tar -xf "%TEMP%\mpv-win.7z" -C "%TEMP%\mpv-extract" 2>nul
  if not exist "%TEMP%\mpv-extract\mpv.exe" (
    where 7z >nul 2>nul
    if errorlevel 1 (
      echo.
      echo 解压失败：这台电脑上既没有 tar 也没有 7-Zip。请先装 7-Zip（官网下载），再重新双击这个文件。
      pause
      exit /b 1
    )
    7z x "%TEMP%\mpv-win.7z" -o"%TEMP%\mpv-extract" mpv.exe d3dcompiler_43.dll -y >nul
  )
  if not exist "%TEMP%\mpv-extract\mpv.exe" (
    echo.
    echo 解压后还是没找到 mpv.exe，请把报错截图发给 Muse。
    pause
    exit /b 1
  )
  copy /y "%TEMP%\mpv-extract\mpv.exe" "%~dp0resources\mpv\mpv.exe" >nul
  if exist "%TEMP%\mpv-extract\d3dcompiler_43.dll" copy /y "%TEMP%\mpv-extract\d3dcompiler_43.dll" "%~dp0resources\mpv\d3dcompiler_43.dll" >nul
  echo 内置 mpv 已准备好。
)

echo.
echo [3/4] 正在打包绿色免安装版（GreenVibe.exe，含内置 mpv）...
call npx electron-builder --win portable
if errorlevel 1 (
  echo.
  echo 绿色版打包失败，正在改打解压文件夹版...
  call npx electron-builder --win dir --x64
  if errorlevel 1 (
    echo.
    echo 打包失败了。请把上面红色的报错截图发给 Muse。
    pause
    exit /b 1
  )
  echo.
  echo 打包成功！解压文件夹版在这里：
  echo   %~dp0dist\win-unpacked\GreenVibe.exe
  echo 双击那个 GreenVibe.exe 就能打开，内置 mpv 已经在里面了。
  pause
  exit /b 0
)

echo.
echo 打包成功！绿色免安装版在这里：
echo   %~dp0dist\GreenVibe.exe
echo 双击 GreenVibe.exe 就能打开，不用安装，内置 mpv 已经在里面了。
echo 如果找不到，请打开 dist 文件夹看一下。
pause
