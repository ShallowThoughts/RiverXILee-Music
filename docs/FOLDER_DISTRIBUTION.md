# RiverXILee桌面歌词：文件夹版

发布者：RiverXILee。适用于 Windows 10 / 11 x64，需要系统 WebView2 Runtime。

项目许可证：GNU GPL v3.0（GPL-3.0-only），见同目录 LICENSE。
第三方依赖声明见 THIRD_PARTY_NOTICES.txt。

## 如何运行

1. 将 ZIP **完整解压**到单独文件夹，例如 E:\Apps\RiverXILee桌面歌词。
2. 双击文件夹中的 riverxilee-desktop-lyrics.exe。
3. 不要直接在压缩软件内运行，也不要只复制主程序 EXE。

## 目录结构

    RiverXILee-Desktop-Lyrics_版本_x64/
      riverxilee-desktop-lyrics.exe   主程序
      resources/
        web/
          index.html                界面入口
          asset-manifest.json       资源版本、文件清单与 SHA-256
          assets/                   实际加载的 JavaScript、CSS、字体和图标
      README.md

界面资源从 resources/web 读取，不再作为完整前端嵌入主程序。
安装版使用相同资源布局，另外由安装器管理快捷方式和卸载程序。
不要修改或单独替换资源文件；启动时会校验版本和文件完整性。
文件校验用于发现损坏、缺失或混装，不等同于数字签名或“已验证发布者”。

## 配置与更新

- 窗口位置、显示方案、快捷键、播放器选择与缓存继续使用原有 Windows 用户数据目录。
- 文件夹版免安装，但不是“配置全部随文件夹迁移”的绿色模式。
- 更新前从系统托盘完全退出软件。将新包解压到新的独立文件夹后运行，不要混合两个版本的 resources。
- 应用内更新仍下载安装包；若希望继续使用文件夹版，请手动下载新版 ZIP。
- 重复启动会唤醒已有实例；如果仍出现旧界面，先从托盘退出旧实例。
- 如提示资源缺失或版本不匹配，请重新完整解压，或用安装包修复。

开发诊断：在终端运行主程序并传入 --check-resources，只校验资源后退出，不打开歌词窗口。
