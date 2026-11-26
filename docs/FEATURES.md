# 功能对照：DeepSeek Harness → DSH Mobile

基准：上游 `deepseek-ai/deepseek-harness` master（v0.2.2‑rc.5，2026‑11‑18）的 Web UI（`dsh web`）与 Web 标准预设。
图例：✅ 已移植（行为与上游一致或逐字移植文本）· 🔁 适配移植（手机上的等价实现）· ⛔ 不适用（依赖手机没有的能力）

## 模型与协议

| 上游 | 状态 | 说明 |
|---|---|---|
| DeepSeek 官方路由（Anthropic Messages 协议，`/anthropic/v1/messages`） | ✅ | SSE 解析、thinking 块与 signature 回传（同模型才带签名）、`in-history` 系统提示更新、tool_result 合并规则、推理等级 off/low/high/max → `thinking` + `output_config.effort` |
| 官方模型列表 `GET /models` 及回退 | ✅ | 5 秒首次等待、10 分钟后台刷新、按 `api_capabilities.anthropic_messages` 等规则筛选，失败回退内置 deepseek-flash / deepseek-v4-pro |
| 自定义模型 API（OpenAI Chat Completions / Anthropic Messages） | ✅ | Provider ID、Base URL、协议、密钥、获取可用模型、逐模型上下文/输出/图片输入/推理等级映射、`thinkingFormat: deepseek`、`maxTokensField` |
| 第三方提供商目录 | 🔁 | 预置端点（DeepSeek OpenAI 兼容、Kimi、GLM、Qwen、SiliconFlow、OpenRouter、OpenAI、Anthropic），模型通过“获取可用模型”填充 |
| 错误分类与重试（AUTH/QUOTA/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED…，5 次指数退避 + Retry‑After） | ✅ | 设置里可改重试策略 |
| 写入式密钥、掩码预览 | ✅ | WP 用 PasswordVault 保存；Web 版用 localStorage；密钥永远不进入智能体可读的文件系统 |
| DeepSeek 账号登录（平台 OAuth） | 🔁 | 改用 API Key；“账号与余额”页通过 `/user/balance` 显示余额 |

## 智能体运行时

| 上游 | 状态 | 说明 |
|---|---|---|
| 收件箱 queue / steer、轮次 → 步骤循环、流式、并行工具（并发安全工具最多 10 个并行，结果按模型顺序提交） | ✅ | |
| 中止语义（已显示内容保存为 interrupted、未开始工具得到 aborted 结果）、崩溃/挂起后的补全修复 | ✅ | 合成结果文本逐字移植 |
| 系统提示分段（身份、persona、计划模式策略、各工具指引、子智能体指引、MCP 指令） | ✅ | 文本逐字移植；新增“设备”段说明手机环境 |
| 运行时上下文提醒（工作目录、沙箱策略、审批策略、子智能体身份、深度警告）、时间上下文、AGENTS.md/CLAUDE.md 指令链（含 .local、预算、深层目录追加） | ✅ | |
| 技能（`.dsh/skills`、`.agents/skills`、用户技能目录、内置技能；catalog 提醒；`skill` 工具；`/技能名` 直接调用） | ✅ | 内置 `create-skill`、`dsh-mobile` 两个技能 |
| 压缩（阈值 min(0.8W, W−O−65536)、保留 16% 尾部、先裁剪超长工具结果、摘要提示词逐字移植、溢出时压缩重试、`/compact`） | ✅ | 已用真实 API 验证 |
| 重复工具调用提醒（3/5/8 次） | ✅ | |
| 会话日志（JSONL 事件、可见面视图、替换语义）、分叉、LLM 生成标题 | ✅ | |
| 权限预设 仅可查看 / 工作区内修改 / 完全权限，沙箱拒绝 + `sandbox_permissions` 提权审批 | ✅ | 已用 UI 验证完整流程 |
| “自动审查”实验预设 | ⛔ | 上游标注为实验功能，未移植 |

## 工具

| 上游工具 | 状态 | 说明 |
|---|---|---|
| read / write / edit / apply_patch / read_image | ✅ | 输出格式、限制、CRLF 保留、错误文本与上游一致；read 对目录列出条目（手机没有 ls）；apply_patch 与上游一样默认关闭，可在插件页开启 |
| glob / grep | 🔁 | 上游调用 ripgrep 二进制；这里在进程内实现，参数与输出格式一致（100/250 上限、溢出写入 spill 文件、.gitignore） |
| todo_write、exit_plan_mode、ask_user_question、present | ✅ | |
| subagent / subagent_fork / send_message / list_agents / wait_agent / list_subagent_models | ✅ | 子会话可在 UI 中打开继续对话 |
| workflow（agent / pipeline / parallel / phase / log / args，支持后台运行） | ✅ | 脚本在沙箱 Worker 中运行，agent() 启动真实子智能体 |
| create_goal / get_goal / update_goal + 目标轮次驱动、`/goal` | ✅ | |
| schedule_create / list / view / edit + 自动化任务页面 | 🔁 | RRULE 子集按上游规则实现；TZID 按手机本地时区计算；应用运行时投递，启动时补投最近一次错过的任务 |
| web_search（DeepSeek 服务端搜索 / Search API） | ✅ | |
| web_fetch（直连 / DeepSeek Fetch API） | 🔁 | HTML→Markdown 转换器为自研（上游用 turndown）；WP8.1 上直连自动经网关 |
| MCP 工具与资源（`mcp__服务器__工具`、list/read 资源） | 🔁 | 仅支持 Streamable HTTP 服务器（手机不能启动 stdio 进程） |
| bash / pwsh / 持久终端 / jobs / PTC run_code(TypeScript) | 🔁 | 手机没有 shell，统一由 **run_code** 代替：沙箱 Worker 里运行现代 JavaScript（sval 解释器，WP8.1 的 ES5 引擎也能跑），用 `await tools.x()` 调用其他工具。Worker 内置完整的 ES2015–ES2023 内置对象补丁（IE11 缺 `Object.entries`、`Array.from`、`padStart` 等），并在构建时给 sval 0.6.12 打了两处补丁：async 函数里“无构造函数的 class 无法 new”，以及 IE11 仍遵循 ES5、函数的 `length` 不可重定义（真机报错 “Cannot redefine non-configurable property 'length'”）。不含 `await` 的代码走同步快速路径（IE11 上约快 45 倍）。`npm run test:ie11` 在模拟 IE11（缺失内置对象 + ES5 对象语义）的环境里回归验证 35 种写法；每次运行结果会回传到网关日志 |
| lsp、ssh、terminal_*、browser-use(stagehand)、computer-use、office_*、worktree、load_workspace_dependencies、plugin_manager / plugin_market、team_task_*、cordis_inspect | ⛔ | 依赖桌面进程、原生二进制或 npm 插件体系 |

## Web UI 操作流程

| 上游 | 状态 | 说明 |
|---|---|---|
| 首次运行：预览说明 → 添加 API Key（稍后配置 / 保存并继续） | ✅ | WP8.1 额外引导网关地址与访问码 |
| 工作区：默认工作区、选择/添加工作区、新建文件夹 | 🔁 | 应用内文件夹 + APPX 中可选择手机/SD 卡上的文件夹（FolderPicker + FutureAccessList） |
| 会话列表：按工作区分组、排序、筛选已归档、置顶、重命名、分叉、复制 ID、标记已读/未读、归档+撤销、搜索（标题+内容）、“展开其余 n 个会话” | ✅ | 长按弹出菜单（手机交互） |
| 输入框：`/` 指令菜单（file/goal/plan/feedback/compact/permission/model/export/技能）、`@` 文件引用、图片附件、模型+推理等级、权限胶囊、计划胶囊、发送/停止/排队/插话（长按发送键切换） | ✅ | |
| 排队区（编辑/移除/插话）、任务区、目标区 | ✅ | |
| 对话渲染：思考、工具卡片（输入/输出详情）、diff、待办、搜索来源、子智能体链接、交付文件、压缩标记、重试提示、错误 + 继续生成、输出上限提示、复制/点赞/点踩/分支/本轮用量 | ✅ | 工作步骤展示 简洁/标准/详细/完全展开 |
| 审批卡片、提问卡片（单选/多选/自定义/跳过）、计划审阅卡片（同意/要求修改/查看全文） | ✅ | |
| 会话面板：工作目录、子智能体、交付文件、统计（请求数、tokens、缓存、TTFT、tok/s、上下文占用） | ✅ | |
| 右侧栏：工作区文件、文档预览、编辑 | 🔁 | 手机上为独立页面；终端/浏览器标签页 ⛔ |
| 设置：通用（权限、语言、外观、字号、工作步骤、繁忙时发送、用量显示）、模型、账号与余额、Agent 预设（标准 / PTC / 精简） | ✅ | 新增“网络网关”设置 |
| 插件页：内置插件设置（子智能体、联网搜索与抓取、Agent 循环、代码执行）、MCP、技能 | 🔁 | npm 插件安装/市场 ⛔ |
| 自动化任务：筛选、新建、规则/记录、暂停/继续、立即运行、删除、清除已结束 | ✅ | |
| 导出：复制会话为 Markdown、下载 Session 日志、`/export` | ✅ | 写入工作区 `dsh-exports/` |
| 中英双语、深色/浅色 | ✅ | |
| 快捷键 | ⛔ | 手机无物理键盘；用硬件返回键导航 |

## 移植版新增

| 功能 | 说明 |
|---|---|
| 设备自检（设置 → 关于 → 设备自检） | 在手机上逐项检查存储、凭据库、图片处理、代码沙箱（与 `npm run test:ie11` 相同的 35 种写法）、网络、DeepSeek 接口（列表、余额、流式、思考、工具调用、中途停止）、智能体全流程（工具链、提问、计划模式、提权审批、联网搜索/抓取、子智能体、workflow、压缩、定时任务、MCP、网关转发）和各页面渲染；自检用的会话与文件夹结束后自动删除 |
| 用手机操作电脑（首页 → 更多 → 电脑上的 dsh） | 网关加 `--dsh` 后运行电脑上的 `dsh --profile acp`，手机通过 ACP 协议驱动它：新建/继续会话、选择电脑上的文件夹、看到思考、回复和工具调用、在手机上批准或拒绝、停止、切换模型。上表中因手机没有而 ⛔ 的能力（bash、终端、浏览器、computer use 等）都可以由电脑上的 dsh 完成 |
| 手机体验 | 键盘（InputPane）弹出时界面让出位置，发送后保持键盘；技术类输入框关闭自动纠错并用合适的键盘；中文输入法组字时不误触 `/`、`@` 菜单；状态栏进度、开始屏幕磁贴与角标、需要确认时振动、点通知打开对应会话；Windows 10 Mobile 上申请后台运行（ExtendedExecution）；Metro 风格的按压与页面动画 |
| `scripts/device-test.mjs` | 通过 Windows 设备门户在 Wi‑Fi 下安装 APPX、下发自检请求并启动应用，结果实时回传到网关（`--selftest`），保存在 `dist/selftest/` |
| `scripts/wdp.mjs` | 无依赖的设备门户命令行：安装、启动、停止、卸载，读写应用数据 |
| 局域网网关 `gateway/server.mjs` | WP8.1 的 HTTPS 转发与密钥注入、托管 Web 版、收集客户端错误与自检报告、MCP 测试服务器 |
