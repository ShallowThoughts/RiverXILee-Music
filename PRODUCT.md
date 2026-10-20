# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are Windows listeners who want synchronized online lyrics to remain visible over their desktop, creative work, streams, or borderless-window games without opening a music client's own lyric overlay. This record is inferred from the existing product and the user's confirmed requests.

## Product Purpose

RiverXILee桌面歌词 recognizes supported Windows music-player sessions, matches online lyrics, and keeps those lyrics readable, movable, configurable, and synchronized in a transparent always-on-top window. Success means the correct song and lyric timeline remain visible without interrupting the user's current activity.

## Positioning

The product combines a strict music-client allowlist, online lyric matching, player timeline reconciliation, word-level highlighting when available, and a deeply configurable transparent desktop overlay. It intentionally ignores browsers and ordinary video applications to reduce false captures.

## Operating Context

The application runs on Windows 10 or 11 alongside QQ Music, NetEase Cloud Music, Kugou, Kuwo, Qishui, Spotify, Apple Music, and other supported clients. It is commonly used over a desktop, livestream layout, or borderless game. Installation and update must preserve the user's saved window position, visual settings, shortcuts, lyric cache, selected player, and per-track offsets.

## Capabilities and Constraints

- The desktop app is built with Tauri 2, Rust, and a web frontend.
- Online lyrics are required because users may not have local audio files.
- The app supports one to five lyric rows, configurable spacing, size, position, local fonts, RGB or solid highlighting, topmost mode, fullscreen, click-through locking, global shortcuts, tray operation, diagnostics, and automatic update checks.
- The installer must support both first install and in-place update through the same branded interface.
- In-place update must retain AppData configuration and replace the existing installed version rather than create parallel uninstall entries.
- Windows verified-publisher status remains unavailable until a matching Authenticode certificate is supplied.

## Brand Commitments

- Product name: RiverXILee桌面歌词.
- Publisher, author, and vendor identity: RiverXILee.
- The application identity and uninstall identity must remain stable across versions.
- The existing interface uses a dark transparent music-focused world, restrained cyan, pink, and mint chromatic accents, fluid motion, and liquid-glass controls.
- Product copy is direct, modern, and primarily Simplified Chinese.

## Evidence on Hand

- Existing desktop application source and production builds in this repository.
- Existing application icon and startup animation.
- Existing liquid-glass control treatment in `src/styles.css`.
- Existing v1.1.1 Windows installation and AppData configuration on the current machine.
- No code-signing certificate is currently available.

## Product Principles

- Lyrics should remain present without stealing attention from music, work, streaming, or games.
- Correct player and timeline selection matter more than recognizing every possible media source.
- Personal display and synchronization settings must survive restarts and updates.
- Installation and updates should feel like part of the product, not a separate generic utility.
- Security claims must be backed by real integrity checks and must not be confused with Windows publisher verification.
