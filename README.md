# RiverXILee桌面歌词 1.0.0

一个为 Windows 设计的沉浸式透明多平台桌面歌词工具。RiverXILee桌面歌词通过 Windows 系统媒体会话识别当前正在播放的歌曲、播放状态和时间轴，再自动匹配在线歌词，无需本地音频。

## 下载

- [RiverXILee桌面歌词 1.0.0 安装版](https://github.com/ShallowThoughts/RiverXILee-Music/releases/download/v1.0.0/RiverXILee-Desktop-Lyrics_1.0.0_x64-setup.exe)
- [RiverXILee桌面歌词 1.0.0 便携版](https://github.com/ShallowThoughts/RiverXILee-Music/releases/download/v1.0.0/RiverXILee-Desktop-Lyrics_1.0.0_portable.exe)

## 使用方法

1. 打开音乐平台并播放任意在线歌曲。
2. 启动“RiverXILee桌面歌词”。无需开启播放器自带的桌面歌词。
3. 鼠标移入窗口底部即可显示控制条。
4. 点击图钉切换置顶，点击四角图标切换全屏。
5. 点击锁图标后窗口会鼠标穿透；按 `Ctrl + Shift + L` 解锁。

## 游戏中显示

窗口化和无边框全屏游戏可以正常显示置顶歌词。少数使用独占全屏的游戏会覆盖普通桌面窗口，请把游戏显示模式改为“无边框”。应用不向游戏进程注入代码。

## 能力

- 仅识别音乐客户端白名单中的 Windows 媒体会话，未知来源默认忽略
- 支持 QQ 音乐、网易云音乐、酷狗音乐、酷我音乐、汽水音乐、Spotify、Apple Music 等主流音乐客户端
- 自动忽略抖音、哔哩哔哩、浏览器及普通视频播放器，避免视频时间轴抢占或卡住歌词同步
- 同步播放、暂停和实时时间轴
- 使用歌名、歌手、专辑和时长自动匹配 QQ 曲库在线 LRC 歌词
- 上一首、播放/暂停、下一首控制
- 透明无边框窗口、始终置顶和全屏
- 沉浸式五行布局：上两句、当前句、下两句
- 当前歌词按演唱进度逐字扫色，可切换 RGB 流光或自定义纯色
- 透明设置面板可调 1～5 行、字号、行间距、上下位置和左右位置
- 支持取色器及 R/G/B 数值输入，显示设置自动保存
- 换句时上浮、失焦与聚焦过渡
- 鼠标穿透锁定与全局快捷键解锁
- 适合明暗背景的歌词描边、阴影和逐行高亮

## 开发与构建

```powershell
npm install
npm test
npm run tauri dev
npm run tauri build
```

运行环境为 Windows 10/11，使用 Tauri 2、Rust 和原生 Windows GSMTC 媒体接口。受支持的音乐客户端需要向 Windows 提供媒体会话、歌曲信息和时间轴；浏览器网页和未列入白名单的播放器不会参与同步。
