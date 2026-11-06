# Steam 歌词状态兼容性契约

状态：**已纳入 v1.2.0 开发计划，尚未实现**  
适用基线：RiverXILee桌面歌词 v1.1.4 及后续版本

## 为什么保留这份文档

RiverXILee桌面歌词已经拥有当前歌曲、歌手、播放状态、播放位置和激活歌词。未来版本计划在不破坏歌词显示的前提下，将这些数据交给可选的状态分享 Provider。

这份文档用于避免后续更新出现以下问题：

- 重构歌词会话时丢失状态分享所需的数据出口；
- 把尚未实现的 Steam 功能写成已交付能力；
- 为了绕过 Steam 限制而引入账号凭据、客户端注入或共享 AppID；
- 更新后遗失用户的隐私选择或在退出后留下陈旧状态；
- 把状态网络逻辑混进歌词动画，造成暂停、跳转或快速切歌不同步。

## 产品目标

在用户主动开启后，状态分享模块可以使用以下数据：

- 歌曲名；
- 歌手名；
- 当前播放或暂停状态；
- 当前激活歌词；
- 当前歌曲或歌词会话的稳定标识。

建议的展示格式：

```text
正在听：歌曲名 — 歌手
♪ 当前歌词
```

无有效歌词时只显示歌曲和歌手。纯音乐、歌词加载中、歌词为空或内容不适合公开时，不发送歌词正文。

## Steam 官方能力边界

Steamworks `ISteamFriends::SetRichPresence` 的 `status` 字段可以保存自定义 UTF-8 状态，但 Steam 好友列表主界面使用的 `steam_display` 必须引用该 AppID 开发者在 Steamworks 后台配置的本地化模板。

因此：

- 没有 RiverXILee桌面歌词自己的 Steamworks AppID 时，不能承诺在 Steam 好友列表主界面逐句显示歌词；
- 不得借用其他游戏的 AppID，也不得使用 Spacewar 480 作为发行实现；
- 非 Steam 游戏快捷方式只能可靠显示其固定名称，不能作为逐句动态歌词的正式实现；
- 在取得正式 AppID并完成后台模板配置前，界面必须清楚标注“需要 Steamworks AppID”或保持该 Provider 不可用；
- 不得用账号密码、Cookie、二维码登录、模拟 Steam 客户端、修改 `shortcuts.vdf` 或向 Steam 进程注入代码绕过限制。

官方参考：

- <https://partner.steamgames.com/doc/api/isteamfriends#setrichpresence>
- <https://partner.steamgames.com/doc/store/application>

## 实现边界

状态分享应保持独立的数据流：

```text
Windows 媒体会话
  -> 现有播放/歌词会话
  -> 状态快照格式化器
  -> 可选 Provider
       -> Steamworks（仅正式 AppID）
       -> 未来其他明确批准的本地 Provider
```

模块职责：

- `src/lyric-view.js` 继续只负责歌词 DOM、逐字进度和动画，不承担状态分享逻辑；
- `src/main.js` 或歌词会话层只发布稳定、可测试的状态快照；
- Provider 调用、节流、Steam 初始化和退出清理放在独立模块或 Tauri 后端；
- Provider 失败不得阻塞歌词获取、歌词动画、媒体控制或应用退出。

## 设置与隐私契约

未来实现至少包含以下行为：

- 状态分享默认关闭；
- 用户可以分别控制是否公开歌名、歌手和当前歌词；
- 当前歌词是最敏感的选项，必须单独开关；
- 设置升级时保留用户选择；旧版本没有该字段时按默认关闭处理；
- 暂停时不得继续滚动歌词；是否显示“已暂停”由产品设置决定；
- 更新应按歌词行和歌曲变化触发，并设置合理节流，不能逐帧发送；
- 关闭选项、切换 Provider、退出应用或 Steam 连接失效时清理本应用设置的状态；
- 日志和诊断报告不得记录 Steam 密码、Cookie、令牌或完整私人歌词历史。

建议预留的设置结构（名称可在实现时按现有设置风格调整）：

```json
{
  "statusSharing": {
    "enabled": false,
    "provider": "none",
    "includeTitle": true,
    "includeArtist": true,
    "includeLyric": false
  }
}
```

该 JSON 是设计示例，不表示这些字段已经存在。

## 验收门槛

纳入 v1.2.0 计划不等于承诺随版上线。若正式 AppID、显示模板或真实 Steam 客户端与好友视角验证未就绪，Steam 功能继续保持不可用，且不列入 v1.2.0 已交付功能。

只有同时满足以下条件，才能把 Steam 歌词状态写进 README、CHANGELOG 或发行说明：

1. 使用 RiverXILee 自有且有权配置的 Steamworks AppID；
2. Steamworks 后台已配置并生效 `steam_display` 本地化模板；
3. 在真实 Steam 客户端和至少一个好友视角验证显示位置与内容；
4. 验证播放、暂停、切歌、跳转、无歌词和退出清理；
5. 验证没有 Steam、Steam 离线和 Provider 报错时桌面歌词仍正常工作；
6. 自动化测试覆盖格式化、隐私、节流、失败隔离和清理；
7. `npm test`、`npm run build` 和 Tauri 本地候选构建通过；
8. 用户确认本地候选效果后，才可以进入发布流程。

## 跨版本更新检查清单

每次修改歌词会话、设置存储、应用退出流程或 Tauri 命令时检查：

- [ ] 状态分享所需的歌曲、歌手、播放状态和激活歌词仍可从稳定接口获得；
- [ ] 设置迁移没有把旧用户默认改成公开状态；
- [ ] Provider 失败不会影响主歌词流程；
- [ ] 退出和关闭开关仍执行状态清理；
- [ ] 没有新增 Steam 凭据、Cookie、注入或共享 AppID依赖；
- [ ] 文档准确区分“规划”“本地候选”“已验证”和“已发布”；
- [ ] 若功能已实现，对应自动化测试仍通过。

