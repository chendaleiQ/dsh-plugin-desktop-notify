# dsh-plugin-desktop-notify

给 DSH 加**桌面通知 + 应用图标小红点**：任务完成、等待你操作、任务失败时提醒你，点通知直接回到那个会话。

[![npm](https://img.shields.io/npm/v/dsh-plugin-desktop-notify)](https://www.npmjs.com/package/dsh-plugin-desktop-notify)
[![license](https://img.shields.io/npm/l/dsh-plugin-desktop-notify)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/chendaleiQ/dsh-plugin-desktop-notify)

![任务在后台跑完弹横幅、点一下回到会话、角标清零](https://raw.githubusercontent.com/chendaleiQ/dsh-plugin-desktop-notify/main/assets/demo.gif)

## 它做什么

- **任务完成**——包括窗口切到后台、你在别的应用里的时候
- **等待你操作**——工具审批、提问、执行计划确认
- **任务失败**——这一轮出错时提示
- **小红点**——应用图标上显示「需要你的会话数」，你看过之后才清零
- **点击通知**——切到对应会话，而不是只把应用叫到前面

子智能体的会话默认不提醒（可在偏好里打开）。

## 安装

DSH 桌面版 → 左侧栏「插件」→ 安装，填包名：

```
dsh-plugin-desktop-notify
```

装完按 **⌘R** 刷新窗口。也可以填 GitHub 地址
（`https://github.com/chendaleiQ/dsh-plugin-desktop-notify`）或本地目录的绝对路径。

## 偏好

存在浏览器 localStorage 的 `dsh-plugin-desktop-notify.preferences`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `notifications` | `true` | 总开关 |
| `notifyComplete` | `true` | 任务完成时通知 |
| `notifyPending` | `true` | 等待审批 / 回答 / 计划确认时通知 |
| `notifyError` | `true` | 任务失败时通知 |
| `notifyViewed` | `false` | 正在看的会话也通知（默认跳过） |
| `badge` | `true` | 显示小红点 |
| `excludeSubagents` | `true` | 忽略子智能体会话 |
| `titleComplete` / `titlePending` / `titleError` | 空 | 自定义标题，空 = 用内置文案 |
| `maxBodyChars` | `140` | 正文长度上限 |

## 语言

跟随 DSH 的语言设置（设置 → 通用 → 语言）：默认中文，切成英文后通知文案同步变成英文。

## 自检

渲染层控制台：

```js
__DSH_DESKTOP_NOTIFY__.capabilities()   // 平台、通知权限、小红点、服务可达性
__DSH_DESKTOP_NOTIFY__.state()          // 小红点、待处理会话、最近一次通知/点击
__DSH_DESKTOP_NOTIFY__.report()         // 上面全部 + 窗口焦点，便于排查
```


## 给其它工具用的通知接口

宿主半边在**回环地址**上开了两个路由，供脚本、浏览器代理、定时任务调用：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/desktop-notify/request` | 发一条通知，body：`{"title": "...", "body": "...", "sessionId": "可选"}` |
| `GET` | `/desktop-notify/pending` | 渲染层取走待显示的通知（脚本不用调） |

地址写在 `~/.dsh/desktop-notify.endpoint`，所以调用方不用猜端口：

```bash
curl -s "$(cat ~/.dsh/desktop-notify.endpoint)" \
  -H 'content-type: application/json' \
  -d '{"title":"BrowserOS 需要你","body":"有一个接管请求"}'
```

Python（比如监听 neo 的守护脚本）：

```python
import json, pathlib, urllib.request

url = pathlib.Path.home().joinpath(".dsh/desktop-notify.endpoint").read_text().strip()
request = urllib.request.Request(
    url,
    data=json.dumps({"title": "BrowserOS 需要你", "body": "有一个接管请求"}).encode(),
    headers={"content-type": "application/json"},
)
urllib.request.urlopen(request, timeout=3).read()
```

要点：

- 通知由 **DSH 自己弹出**（归属 DeepSeek Harness），不是 Script Editor
- 点通知会把窗口叫到前面；带 `sessionId` 时会切到那个会话
- 接口只监听回环地址，不需要登录；`enabled: false` 只关 osascript 兜底，不影响接口

## 已知限制

- **Windows**：点通知会切到对应会话，但窗口不一定到前台——`AppUserModelID` 和主进程 focus 通道属于桌面端，渲染层插件做不到
- **通知归属**：系统通知中心里显示为 DeepSeek Harness（用的是渲染层原生通知）
- **宿主半边**（`index.js`，osascript 兜底）默认关闭；只有渲染层拿不到 `Notification` 时才需要打开

## 开发

```bash
node test/client.test.mjs      # 渲染层：文案、小红点、点击链路
node test/host.test.mjs        # 宿主兜底：dryRun 下的事件处理
```

## 协议

MIT · 仓库 https://github.com/chendaleiQ/dsh-plugin-desktop-notify
