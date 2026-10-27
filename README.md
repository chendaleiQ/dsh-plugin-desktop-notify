# dsh-plugin-desktop-notify

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面版补上 **Codex 风格的系统通知 + 程序坞小红点**：

- 任务跑完（**包括窗口在后台/最小化时**）弹一条 **DeepSeek Harness 自己发的** macOS 横幅；
- 有工具等你审批、有提问等你回答、有计划等你确认时弹「需要你确认」；
- 任务出错时弹「任务出错」，正文带错误摘要；
- **点横幅直接回到那个会话**并抬起窗口；
- 需要你处理的会话在 Dock 图标上留一个数字，直到你真的看过它才清零。

[English](README.en.md) · MIT

## 和 Codex 桌面版对齐

| Codex 桌面版 | 这里 |
|---|---|
| Settings → Notifications → **Task completion** | 「DSH 任务完成」：会话跑完时，你没在看它 |
| Settings → Notifications → **Approval required** | 「DSH 需要你确认」：有工具等你批准 |
| 等你回复（提问 / 计划确认） | 「DSH 需要你确认」：有提问等你回答、有计划等你确认 |
| 任务失败 | 「DSH 任务出错」：正文带错误摘要 |
| Dock 徽标 | 数字 = **当前需要你的会话数**；打开该会话即清 |

规则：

- **有通知就有红点**：两者读同一份 attention 事实，弹了横幅就一定进徽标。
- **「在看」才算看过**：`主视图是它` **且** `窗口有焦点` **且** `窗口可见`，三者同时成立才不打扰。
  宿主的 `completionUnread` 只覆盖第一种（切到别的会话）；窗口被切到后台时它看不见，
  这部分由插件用 `document.hasFocus()` / `visibilityState` 自己补——否则最常见的那种
  「切到别的 App 等它跑完」永远不会提醒。
- **红点粘住**：弹过横幅的会话，红点保留到你真的切回来并看着它；宿主把 `completionUnread`
  清掉并不会让红点消失。
- **失败不重复播**：一轮以错误结束时只发「任务出错」，不再补一条「任务完成」。
- 子会话（subagent / Agent Teams 成员）不弹不计；同一会话同类横幅用 `tag` 覆盖，不堆一屏。

## 兼容性

- **已在 macOS 实测**：DSH Desktop 0.2.1-rc.3（Electron 44.7.0）。
- 需要桌面端把 `dsh-app://` 注册为 secure context（现版本就是这么做的），否则渲染层拿不到
  `navigator.setAppBadge` 与 `Notification`；`capabilities()` 自检里会显示 `badge: false`。
- 系统设置 → 通知 → **DeepSeek Harness** 必须是允许状态，否则只有红点没有横幅。
- **Windows / Linux：未实测，但理论上可用**。渲染层用的是标准 Web API：
  Electron 从 29 起支持 Windows 上的 Badging API（任务栏 overlay，修过 [Windows 下徽标文字不显示](https://releases.electronjs.org/release/v29.1.5)），
  `Notification` 走 Windows toast。真正的风险在 Windows 的 toast 需要 AppUserModelID +
  开始菜单快捷方式，而 DSH 主进程没有显式 `setAppUserModelId`（我查过 `lib/main.js`），
  所以能不能出横幅取决于安装包写的快捷方式。
- **唯一确定只在 macOS 的是宿主兜底那半边**（`osascript` / `afplay` / `lsappinfo`），
  它默认关闭，只在你没有 `Notification` 时才需要。
- 想验证 Windows：跑一次 `capabilities()`（会带上 `platform`），再 `simulateComplete()`，
  看 toast 与任务栏数字是否出现，把结果开个 issue 就行。

### Windows 上「有红点、没横幅」

红点走的是任务栏 overlay，不需要 AppUserModelID；**Windows toast 需要 AppUserModelID +
开始菜单快捷方式**才会显示。DSH 主进程没有调用 `app.setAppUserModelId`（`lib/main.js` 里没有
这行），所以 toast 很可能被 Windows 静默丢弃——这不是插件逻辑问题。先确认：

```js
new Notification("test", { body: "windows toast check" })  // 连这条都不弹 = 应用层问题
__DSH_DESKTOP_NOTIFY__.state().lastNotify                   // 插件最后一次投递的结果
```

两条路：等 DSH 主进程补上 `app.setAppUserModelId`（那时现有代码就能正常出 toast 并支持点击）；
或改用宿主侧 PowerShell toast 兜底（能提示，但归属会显示成 Windows PowerShell，点击无法跳回会话）。

## 安装

### 方式一：从 GitHub 安装（推荐）

DSH 桌面版左侧栏 **插件** → **安装**，填仓库地址：

```
https://github.com/chendaleiQ/dsh-plugin-desktop-notify
```

装完按 **⌘R** 刷新窗口（渲染层要重新加载）。提示 `restart-required` 就重启一次应用。

### 方式二：本地目录

```bash
git clone https://github.com/chendaleiQ/dsh-plugin-desktop-notify.git
```

插件页 → 安装 → 填这个目录的**绝对路径**（目录，不是文件）：

```
/path/to/dsh-plugin-desktop-notify
```

### 方式三：开发调试（直接 link 进 profile）

```bash
git clone https://github.com/chendaleiQ/dsh-plugin-desktop-notify.git
cd dsh-plugin-desktop-notify
ln -s "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-plugin-desktop-notify
# 再把 dsh-plugin-desktop-notify 加进 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles
```

改完代码按 ⌘R 重载渲染层即可（Host 那半边改动需要重启应用）。

## 自检

窗口里按 `⌘⌥I` 打开 DevTools，Console：

```js
__DSH_DESKTOP_NOTIFY__.capabilities()       // {notification:"granted", badge:true, ...}
__DSH_DESKTOP_NOTIFY__.state()              // 当前 attention 与徽标数字
__DSH_DESKTOP_NOTIFY__.simulateComplete()   // 立刻弹一条横幅并把 Dock 置 1
__DSH_DESKTOP_NOTIFY__.reset()              // 清掉自检状态
```

手工验收：让一个会话跑十几秒，**切到别的 App**（失焦即可，不必切会话），跑完应看到横幅 + Dock `1`；
点横幅回来，数字清零。

## 偏好

没有设置界面，偏好放在渲染进程本地（desktop / web profile 各自独立），控制台执行后 ⌘R：

```js
localStorage.setItem("dsh-plugin-desktop-notify:preferences", JSON.stringify({
  notifications: true,    // 总开关：横幅
  notifyComplete: true,   // 任务完成
  notifyPending: true,    // 等审批 / 提问 / 计划确认
  notifyError: true,      // 任务失败
  notifyViewed: false,    // true = 盯着看它也弹（但不进红点）
  badge: true,            // 总开关：Dock 红点
  excludeSubagents: true, // 子会话不弹不计（建议保持）
  titleComplete: "DSH 任务完成",
  titlePending: "DSH 需要你确认",
  titleError: "DSH 任务出错",
  maxBodyChars: 140
}))
// 恢复默认
localStorage.removeItem("dsh-plugin-desktop-notify:preferences")
```

## 为什么是渲染层插件

这两件事只能在桌面**渲染进程**做，Host 子进程碰不到：

| 能力 | 接口 | 去处 |
|---|---|---|
| 原生横幅 + 点击回调 | `new Notification(...)` / `onclick` | Electron → macOS 通知中心，**归属 DeepSeek Harness** |
| Dock 小红点 | `navigator.setAppBadge(n)` / `clearAppBadge()` | Chromium → Electron `BadgeManager` → `NSDockTile.badgeLabel` |

宿主半边（`index.js`）保留成**默认关闭的 osascript 兜底**：万一某个渲染环境没有 `Notification`，
把 `cordis.patch.yml` 里的 `enabled` 改成 `true` 再重启——两者同时开会重复提醒。

数据源用的是 Harness 自己的 `uiSession.sessionStatus`（`completionUnread` / `pendingInteraction`，
和侧边栏状态点同源）+ `api-session/error`（失败），插件不自己记账，所以「读过」的语义和官方 UI 一致。

## 目录

```
dsh-plugin-desktop-notify/
├── package.json          # dsh.bundle.patch + dsh.client（渲染层入口与 inject 顺序）
├── cordis.patch.yml      # desktop-notify 一行（宿主兜底默认 enabled: false）
├── lib/client.js         # 渲染层：横幅 + 点击跳转 + Dock 徽标
├── index.js              # Host 半边：osascript 兜底，默认关闭
├── test/client.test.mjs  # 渲染层测试（node:vm + 假浏览器全局）
├── test/host.test.mjs    # 宿主兜底测试
├── icon.svg / locale/{en,zh}.json / README(.en).md / LICENSE
```

## 开发与测试

零依赖，手写 ES 模块，无构建步骤。

```bash
node test/client.test.mjs                     # 渲染层：node:vm + 假 window/navigator/Notification
node test/host.test.mjs /tmp/host-test.log    # 宿主兜底：假 ctx + 合成 session/event
npm test                                      # 两个都跑
```

渲染层测试覆盖 40+ 项断言：边沿只弹一次、后台窗口算「没在看」、红点粘住到真看过、
完成/审批/失败各自增减、失败不重复播、子会话排除、各偏好开关。

## 已知限制

- macOS 已实测；Windows / Linux 未实测（见上面「兼容性」）。
- 「卡住」目前覆盖**等待审批 / 提问 / 计划确认 / 失败**；没有做「还在 running 但长时间无输出」
  的超时判定（需要宿主侧定时器）。
- `completionUnread` 与失败事实在宿主内存里，重启应用从零开始（官方语义）。
- 点击横幅若对应会话已归档，只会抬窗。
- 与 [`@caohaoyangcn/dsh-dock-badge`](https://www.npmjs.com/package/@caohaoyangcn/dsh-dock-badge)
  功能重叠（那个只做徽标、带设置页），**两个都装会抢写同一个 Dock 徽标，只留一个**。

## License

MIT，随便用、随便改、随便发。
