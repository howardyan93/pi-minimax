# pi-minimax-multimodal

把 [MiniMax 开放平台](https://platform.minimaxi.com/docs/api-reference/)的多模态能力接进 [pi](https://github.com/badlogic/pi-mono) 的 23 个工具：
视频（Hailuo H3）、图片（H3-Image）、语音（T2A / ASR / 音色复刻）、音乐、文件管理。

本地文件（图片 / 音频 / 视频）会被自动上传成 `mm_file://{file_id}`，生成结果自动下载到本地并把路径交回模型 ——
模型不需要自己管 URL、base64 或者 CDN。

## 安装

### 本地开发（推荐先这样用）

```bash
cd ~/git/pi-minimax
npm install                     # 只是为了 tsc / @types/node，运行期依赖都由 pi 宿主提供
pi install ./                  # 写入 ~/.pi/agent/settings.json；加 -l 则写入当前项目的 .pi/settings.json
```

只试一次、不装机：

```bash
pi -e ./index.ts
```

改完代码重启 pi 即可生效（扩展是运行时加载的 TypeScript 源码）。

### 之后发布到 npm

包里已经配好 `"keywords": ["pi-package"]`、`"pi": { "extensions": ["./index.ts"] }`，
宿主包 `@earendil-works/pi-coding-agent` 与 `typebox` 放在 `peerDependencies` 而不是 `dependencies`：

```bash
npm publish                       # 包名 pi-minimax-multimodal
pi install npm:pi-minimax-multimodal
```

`files` 只包含 `index.ts` / `src` / `README.md`，源码随包发布，由 pi 现场编译。

## 配置 API Key

按优先级查找：

1. 环境变量 `MINIMAX_API_KEY`
2. `~/.pi/agent/minimax.json` → `{ "apiKey": "sk-..." }`（推荐用 `/minimax set` 生成）
3. `~/.pi/agent/mcp.json` 里 MCP server 的 `env.MINIMAX_API_KEY` —— **需要显式开启** `MINIMAX_ALLOW_MCP_KEY=1`

第 3 项是 opt-in：从别家 MCP 配置里读凭据属于"意料之外的复用"，所以默认**不读** `mcp.json`。
只有你设了 `MINIMAX_ALLOW_MCP_KEY=1`，才会拿 `mcpServers.<name>.env.MINIMAX_API_KEY` 兜底；此时
`/minimax` 里会标出 `(MINIMAX_ALLOW_MCP_KEY=1)`，方便区分 key 的真实来源。

没有任何 key 时，23 个工具会返回一条可读的错误（`… failed: MINIMAX API key not found.` + 三种配置方法），
而不是抛栈；`session_start` 也会在 TUI 里提醒一次。

其它可覆盖项：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MINIMAX_API_BASE` / `MINIMAX_API_HOST` | `https://api.minimax.cn` | 国内站；国际站用 `https://api.minimaxi.com` |
| `MINIMAX_OUTPUT_DIR` | `~/.pi/agent/artifacts/minimax` | 产物落盘目录 |
| `MINIMAX_ALLOW_MCP_KEY` | 未设置（=关闭） | 设为 `1`/`true` 才允许从 `mcp.json` 复用 key |

### 用命令配置并保存 key

```
/minimax set      # 隐藏输入 key → 选站点 → 真实校验 → 写入 ~/.pi/agent/minimax.json
/minimax          # 看当前生效的 key（掩码）、来源、站点、输出目录
/minimax ping     # 用当前 key 打一次 /v1/get_voice
/minimax clear    # 删除已保存的 key
```

`set` 的流程：输入时不回显（只显示 `•`，末 4 位可见便于确认），**支持直接粘贴**——终端的 bracketed paste
（`\x1b[200~ … \x1b[201~`）会被解包，粘贴内容里的换行/空格自动剥离，跨多次读取被切断的粘贴也能拼接；
然后选国内站 / 国际站 / 保持当前，
接着用 `POST /v1/get_voice {voice_type:"system"}` 真实校验这个 key；校验失败会问你要不要仍然保存。
文件以 `0600` 权限写入（已存在更宽松的文件会被收紧），其它字段（`baseUrl`、`outputDir`）保留。

注意优先级：环境变量 `MINIMAX_API_KEY` > `minimax.json` > `mcp.json`（后者需 `MINIMAX_ALLOW_MCP_KEY=1`）。如果你在 shell 里 export 过 key，
`/minimax set` 保存后仍以环境变量为准，命令会提醒你。

非 TUI 模式（`--mode rpc` / json / print）拿不到自定义组件，会退化成可见的输入框；json / print 干脆没有 UI，
此时只能用环境变量或直接写 `minimax.json`。

## 工具一览

所有工具都挂在 `minimax` 命名空间下，参数里的本地路径会就地转成平台可用的引用。

### 视频（`/v2/video_generation`）

| 工具 | 作用 |
| --- | --- |
| `minimax_video_create` | 建任务。一个接口覆盖文生视频、图生视频（`first_frame`）、首尾帧（`first_frame`+`last_frame`）、多模态参考（`reference_images` / `reference_videos` / `reference_audios`）。默认阻塞到结束并下载 mp4 |
| `minimax_video_query` | 按 task_id 查询 / 继续等待，成功后下载 |
| `minimax_video_list` | 近 7 天任务列表，按状态 / 模型 / 类型过滤 |
| `minimax_video_cancel` | 取消排队任务或删除记录 |
| `minimax_video_context_ir` | H3-Context-IR：把粗略创意 + 参考素材改写成结构化提示词 |
| `minimax_video_regenerate` | 768P 源视频再生成 2K |

要点：`model` 为 `MiniMax-H3` / `-Highspeed` / `-Lite` / `-Max`；分辨率 `480P` / `768P` / `2K`（Highspeed、Lite 不支持 2K）；
时长 4~15 秒（Max 为 5~15）；提示词 ≤7000 字符；参考图 ≤9 张（含首尾帧），参考视频 / 音频各 ≤3 段。
图生视频与参考生视频互斥，`first_frame` 不能和 `last_frame` / `reference_images` 混用。

### 图片（`/v1/images/generations`、`/v1/images/edits`）

| 工具 | 作用 |
| --- | --- |
| `minimax_image_generate` | 文生图，1~10 张，`size` / `aspect_ratio` / `area(1K/2K/4K)` 三选一组合 |
| `minimax_image_edit` | 图片编辑 / 合成，1~16 张输入图 |
| `minimax_image_prompt` | H3-Image-Context-IR 改写提示词（同步，不生成图片） |

生成的图片会落盘，并把前 4 张作为图片内容直接返回给模型看（`inline: false` 可关）。

### 语音

| 工具 | 作用 |
| --- | --- |
| `minimax_speech` | 同步 TTS（≤1 万字符），音色 / 语速 / 音量 / 音调 / 情绪 / 采样率 / 码率 / 格式 / 字幕 |
| `minimax_speech_async` | 异步长文本 TTS，轮询到完成后下载 |
| `minimax_transcribe` | ASR（`asr-1.0`），json / verbose_json / srt / vtt + 句级或词级时间戳 |
| `minimax_voice_clone` | 用 10s~5min 人声复刻音色，返回试听音频 |
| `minimax_voice_design` | 文字描述生成新音色 |
| `minimax_voice_list` / `minimax_voice_delete` | 音色列表 / 删除自建音色 |

默认音色 `male-qn-qingse`（系统音色共 300+，用 `minimax_voice_list` 查）。

### 音乐（已对新用户下线）

`minimax_music`、`minimax_music_cover_preprocess`、`minimax_lyrics` 仍在，但 MiniMax 已停止向新账号开放音乐 API
（`status_code 2153` / HTTP 410）。现有付费客户可继续使用；新接入要走
[MiniMax Audio](https://www.minimax.io/audio) 或开源模型
[MiniMax-Music3](https://huggingface.co/MiniMaxAI/MiniMax-Music3)。工具会把这个原因翻译成中文提示。

### 文件（`/v1/files/*`）

`minimax_file_upload` / `minimax_file_list` / `minimax_file_get` / `minimax_file_delete`。
`purpose` 决定文件能用在哪：`video_generation_input`、`image_generation_input`、`voice_clone`、`prompt_audio`、`t2a_async_input`、`video_understanding`。
上传的文件 **7 天后过期**，任务结果 URL 同理。

## 本地文件是怎么进去的

`resolveRef()` 对每个媒体参数做一次判断：

- `https://…`、`data:…`、`mm_file://…` → 原样透传
- 本地路径 → `POST /v1/files/upload`（按用途带 `purpose`），拼成 `mm_file://{file_id}`

所以 `reference_images: ["/home/me/pic.png"]` 和 `["https://…/pic.png"]` 可以混着写。
小图片也可以走 data URI（图片编辑默认 ≤8MB inline），大文件一律走上传，避免 64MB 请求体上限。

## 开发

```bash
npm install          # @types/node + typescript（装在本地，不从宿主借）
npm run typecheck    # tsc --noEmit
node --experimental-strip-types scripts/smoke.ts          # 离线：注册表 + 全部 JSON schema 校验
node --experimental-strip-types scripts/smoke.ts --live    # 真实调 voice_list / lyrics
node --experimental-strip-types scripts/smoke.ts --live --media  # 再加一次 TTS + 一张 1K 图（会计费）
node --experimental-strip-types scripts/smoke.ts --live --video  # 再加一次 H3-Lite/480P/4s 视频（会计费）
```

目录结构：

```
index.ts            扩展入口：注册 5 组工具 + /minimax 命令 + 缺 key 提示
src/config.ts       API key 解析（env → minimax.json → mcp.json opt-in）、base URL、输出目录
src/client.ts       带 Bearer 的 fetch 封装，统一解析 base_resp / OpenAI 式 error
src/media.ts        本地上传、data URI、下载落盘、hex 音频解码
src/shared.ts       结果构造、图片块、格式化、可中断 sleep
src/tools/*.ts      按域拆分的工具注册函数
```

## 注意事项

- 视频任务、上传文件、任务结果都只保留 7 天，长任务请及时下载。
- 建视频任务是计费的；`minimax_video_create` 的 `wait: false` 只提交不等待。
- 音频类响应可能是 hex 也可能是 URL（`output_format`），插件两种都能落盘。
- 请求体上限 64MB；`data:` base64 会让体积膨胀约 1/3，大素材走 `mm_file://`。
- 工具失败时统一返回 `isError: true` 和上游 `status_code` / `trace_id`，便于排查。
