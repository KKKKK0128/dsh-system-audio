# dsh-system-audio

让 DSH 听见**电脑正在播放的声音**（不是麦克风）：用 Windows WASAPI loopback 录制系统输出，
再交给 DSH 自带的本地语音识别（SenseVoice）转成文字，作为语音输入的另一个来源。

入口有两条：① **Agent 工具**——直接说「听一下电脑在放什么」就会调用 `system_audio_listen`；
② **界面**——录音 UI 在 `dsh-interview-mode` 的「模拟面试」侧边栏面板里（从输入框工具行搬过去了），
本插件自身**不再**往输入框注册按钮。

用途举例：把正在播放的视频/音乐/通话/朗读的音频转成文字，交给 Agent 处理。

## 它做了什么

```
扬声器输出 ──WASAPI loopback──▶ native/LoopbackRecorder.exe ──16kHz 单声道 PCM16 WAV──▶
    DSH speechToText（sensevoice-local） ──▶ 文本 ──▶ 交给 Agent / 面试模式投递
```

* **采集端**：`native/LoopbackRecorder.cs`（C# / .NET Framework 4，无需 SDK）
  编译产物 `native/LoopbackRecorder.exe`。直接采集「默认播放设备」的 loopback，
  自动重采样为语音识别唯一接受的规范格式：**16000 Hz / 单声道 / 16bit PCM WAV**。
* **宿主插件**：`lib/index.js`（+ `lib/recorder.js`、`lib/speech.js`、`lib/routes.js`），
  注册 3 个智能体工具，并对外暴露一组同源 HTTP 路由给浏览器半使用；
  识别通过 `ctx.get('speechToText')` 复用官方已装的本地模型，不新增模型、不联网（除首次模型下载）。
* **客户端半**：`lib/client.js` 仍是 `window.__ModuleLoader__` 工厂格式（无需构建步骤），但**当前不注册任何槽位**——
  录音按钮随 `dsh-interview-mode` 的侧边栏面板一起走了；文件保留作历史与自建界面的参考，
  `.test/client-check.mjs` 专门断言「零槽位注册」。
* **不修改任何 DSH 内部文件**：本插件是一个独立 bundle，卸载即恢复原状。

## 安装（本机 profile）

```powershell
# 克隆仓库后，用 DSH 自己的 CLI 以本地路径安装（bundle 会并入 dsh.profile.bundles）
git clone https://github.com/KKKKK0128/dsh-system-audio.git
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "<克隆下来的 dsh-system-audio 目录>"
```

也可以在 DSH 的插件页面里选择本地目录安装。装完**重启 DSH Desktop**：宿主半（`lib/index.js` 等）与包元数据
在进程启动时缓存（ESM/manifest cache），改宿主代码后必须重启才生效——热插拔不会重新 import。
例外：只改 `lib/client.js` **不需要重启**，新代码会被送进运行中的页面（个别情况下按一次 F5）。

## 用法

1. **对 Agent 说**：「听一下电脑现在在放什么」「把这 30 秒的音频转成文字」——走 `system_audio_listen`（录 N 秒直接返回文本）
   或 `system_audio_record`（只录音，返回 WAV 路径 + 电平统计）。
2. **界面**：打开侧边栏的「模拟面试」图标，用那个面板里的按钮开始/停止监听（面板属于 `dsh-interview-mode`，
   它复用本插件的采集与识别；见该仓库 README）。
3. **自己做界面 / 写脚本**：直接打下面的 HTTP 路由——`POST /system-audio/start` 拿 `{id}` →
   轮询 `GET /system-audio/status?id=`（含 `state/elapsed/rms/db/levels[]`，可画电平条）→
   `POST /system-audio/stop` 拿 `{text}`，或 `POST /system-audio/cancel` 丢弃不识别。
4. 默认最长 120 秒、播放停止后再安静 1.5 秒自动收尾（路由参数可改）。

## 智能体工具

| 工具 | 作用 |
| --- | --- |
| `system_audio_devices` | 列出可采集的播放设备 + 当前语音识别是否就绪 |
| `system_audio_listen` | 录 N 秒系统声音并返回识别文本（`seconds` 默认 10，最大 120） |
| `system_audio_record` | 只录音，返回 WAV 路径与电平统计（调试/存档用） |

首次调用 `system_audio_listen` 时，如果 SenseVoice 模型还没下载（约 240 MB int8），
插件会先触发官方下载流程并等待（`wait_ready: false` 可改为立即报错）。

## HTTP 路由（同源 fetch；当前无内置 UI 调用，供自建界面与脚本使用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/system-audio/ping` | 探活 |
| GET | `/system-audio/devices` | 播放设备 + 语音识别状态 |
| POST | `/system-audio/start` | `{seconds?, device?, language?, silenceMs?}` → `{id, transport}` |
| GET | `/system-audio/status?id=` | `{state, elapsed, rms, db, levels[]}` |
| POST | `/system-audio/stop` | `{id}` → 停止并识别 → `{text, language, rms, peak, seconds}` |
| POST | `/system-audio/cancel` | `{id}` → 丢弃，不识别 |

## 命令行用法（不经 DSH，直接验证采集）

```powershell
# 列出播放设备
native\LoopbackRecorder.exe --list-devices

# 录 5 秒到 WAV，并每 100ms 输出电平事件
native\LoopbackRecorder.exe --capture --out out.wav --seconds 5 --levels

# 指定设备 / 静音自动停止 / 外部停止信号
native\LoopbackRecorder.exe --capture --out out.wav --seconds 120 --device "{0.0.0.xxx}" --silence-stop 1500
native\LoopbackRecorder.exe --capture --out out.wav --seconds 120 --stop-file stop.flag

# 管道模式：WAV 走 stdout、事件走 stderr（子进程完全不写文件）
native\LoopbackRecorder.exe --capture --out - --seconds 30 --stop-on-stdin --levels

# 写进子进程自己的临时目录（受限沙箱下唯一可写的临时位置）
native\LoopbackRecorder.exe --capture --out-temp probe.wav --seconds 5

# 异常终止后修复 WAV 头
native\LoopbackRecorder.exe --repair out.wav
```

默认 stdout 是逐行 JSON 事件：`devices` / `start` / `level` / `done` / `error`。
`--out -` 时 stdout 变成二进制 WAV、事件改走 stderr。

## 重新编译采集器

```powershell
native\build.cmd
```

用的是 Windows 自带编译器 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
（C# 5 语法，离线，无 NuGet）。

## 已知限制

* **DRM 保护的内容**（部分流媒体）在系统层就是静音，loopback 也只能录到静音。
* 只录「播放」的声音；麦克风请继续用自带的语音输入按钮。
* 需要系统里存在**已启用的播放设备**；如果设备被禁用，`--list-devices` 会列出但没有默认设备。
* Windows only（WASAPI + .NET Framework）。
* 采集子进程**不写任何文件**：默认走 stdout 管道（WAV + stderr 事件），停止靠关闭 stdin；
  受限沙箱禁止命名管道时会自动退回「写成文件再读」的模式。

## 目录

```
lib/index.js          宿主插件：3 个工具 + 路由接线
lib/recorder.js       采集器进程封装（事件解析、停止、WAV 读取/修补）
lib/speech.js         语音识别串联（就绪等待 resolve/transcribe）
lib/routes.js         /system-audio/* 的宿主 HTTP 路由
lib/client.js         客户端半：保留的 UI 代码，当前不注册槽位（录音按钮已移入 dsh-interview-mode）
native/LoopbackRecorder.cs/.exe   WASAPI loopback 采集器
native/build.cmd      重新编译
cordis.patch.yml      bundle patch（仅 insert 一行）
.test/                离线测试
```

## 测试

```bash
NODE="$USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"  # 或你自己的 node（>=22）
"$NODE" .test/plugin-smoke.mjs   # 工具定义/输出 schema/规范 WAV（无需重启 DSH）
"$NODE" .test/routes-check.mjs   # 真实 HTTP 服务器跑通 6 条路由 + 规范 WAV
"$NODE" .test/client-check.mjs   # 加载客户端半，断言不注册任何槽位（按钮已移走）
bash    .test/live.sh            # 播放音频同时采集，验证电平与优雅停止
"$NODE" .test/live-routes.mjs    # 针对运行中的 DSH 打全部 6 条路由（--play <wav> 边播边录）
"$NODE" .test/live-e2e.mjs       # 验收：真实播放→逐字转写 + 静音自动停止（无需人工）
```
