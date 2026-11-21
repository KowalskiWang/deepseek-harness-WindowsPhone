# DSH Mobile — DeepSeek Harness for Windows Phone

把 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，一个“一切皆插件”的智能体框架）完整移植到 **Lumia / Windows Phone 8.1 / Windows 10 Mobile**。基于 DeepSeek Harness（MIT）移植，非 DeepSeek 官方产品。

```
 Lumia (WP8.1)                         同一 Wi‑Fi 的电脑                      DeepSeek
┌───────────────────────┐   HTTP    ┌──────────────────────────┐  HTTPS   ┌─────────────────┐
│ DSH Mobile             │ ───────▶ │ DSH 网关 gateway/server.mjs│ ───────▶ │ api.deepseek.com │
│  · APPX 原生应用        │          │  · 提供 Web 版页面          │  (现代 TLS)│  /anthropic/v1  │
│  · 或 IE11 局域网 Web 版 │ ◀─────── │  · 转发 HTTPS（+注入密钥）  │ ◀─────── │  /models …      │
└───────────────────────┘   SSE    └──────────────────────────┘           └─────────────────┘
```

WP8.1 的系统 TLS 不支持 api.deepseek.com 要求的加密套件（已实测），所以需要局域网网关；Windows 10 Mobile 可直连。

已在 **Nokia Lumia 1020（Windows Phone 8.1，IE Mobile 11）** 真机上验证 Web 版：启动、引导、流式对话、文件工具、`run_code`、联网搜索均正常。APPX 版待在 Windows 电脑部署后验证。

## 快速开始

```bash
npm install
npm run build
node gateway/server.mjs --key-file api.txt
```

手机连同一 Wi‑Fi，用 IE 打开终端打印的地址（如 `http://192.168.1.100:8787/`），输入访问码，API Key 留空即可开始；再“固定到开始屏幕”。APPX 安装、Windows 10 Mobile、常见问题见 **[docs/INSTALL.md](docs/INSTALL.md)**。

## 移植了什么

- **智能体运行时**（`src/core/`）：上游 agent-loop 的完整移植——queue/steer 收件箱、轮次/步骤循环、流式、并行工具批处理、中止与崩溃修复、重试退避、系统提示与运行时上下文（文本逐字移植）、AGENTS.md 指令、技能、上下文压缩、子智能体、workflow、目标、定时任务、计划模式、沙箱权限与提权审批、MCP（HTTP）。
- **DeepSeek 协议**：与上游相同走 Anthropic Messages 兼容接口（thinking、签名回传、in-history 系统提示），以及 OpenAI 兼容的自定义提供商。
- **工具**：read / write / edit / apply_patch / read_image / glob / grep / todo_write / exit_plan_mode / ask_user_question / present / web_search / web_fetch / skill / subagent 系列 / workflow / goal 系列 / schedule 系列 / MCP；没有 shell 的手机上，bash 与 PTC 由 **run_code**（沙箱 JavaScript，可 `await tools.x()`）代替。
- **界面**（`src/ui/`）：Metro 风格的手机界面，覆盖上游 Web UI 的全部主要流程——会话列表、工作区、输入框（`/` 指令、`@` 文件、图片、模型/推理等级、权限、计划）、对话渲染、审批/提问/计划审阅卡片、会话面板、文件浏览、设置、插件、自动化任务、中英双语、深浅色。

逐项对照（含未移植项及原因）：**[docs/FEATURES.md](docs/FEATURES.md)**。

## 目录

| 路径 | 内容 |
|---|---|
| `src/core/` | 平台无关的运行时：LLM 适配器、会话、智能体循环、工具、压缩、技能、MCP、定时任务 |
| `src/ui/` | Preact 界面（JSX → Babel → ES5） |
| `src/platform/` | `winrt.js`（APPX：StorageFolder、PasswordVault、选择器、硬件返回键、Toast）、`web.js`（IndexedDB、XHR 流式）、`node.js`（测试） |
| `src/sandbox/` | run_code / workflow 的沙箱 Worker（sval 解释器） |
| `gateway/server.mjs` | 局域网网关（无依赖） |
| `appx/AppxManifest.xml` | WP8.1 应用清单（Windows 10 Mobile 同样可运行） |
| `scripts/` | 构建、ES5 校验、图标生成、APPX 打包签名 |
| `tests/` | 单元测试（`npm test`）与真实 API 联调脚本（`npm run test:live`，读取 `api.txt`） |

## 开发命令

```bash
npm run build            # 生产构建 → dist/web 与 dist/appx（node scripts/build.mjs --dev 为未压缩版）
npm run check:es5        # 确认产物是 IE11 可解析的 ES5
npm test                 # 单元测试（21 项）
npm run test:live        # 用 api.txt 的密钥跑真实 API 联调（LLM 适配器、工具链、压缩）
npm run package:appx     # 构建 + 签名 APPX → dist/package/
npm run gateway -- --key-file api.txt
```

打包依赖 [appx-util](https://github.com/OSInside/appx-util) 和 OpenSSL 3：自行编译 appx-util（`cmake .. -DOPENSSL_ROOT_DIR=$(brew --prefix openssl@3) && make`），把可执行文件放到 `tools/bin/appx` 或设置环境变量 `APPX_UTIL`。签名私钥首次打包时自动生成到 `signing/`（已被 .gitignore 排除，请勿提交）。

## 安全说明

与上游一致：本项目处于开发者预览阶段，智能体可以读写工作区文件、执行沙箱代码、访问网络。请只在可以承受改动的文件夹中使用并做好备份。网关带 `--key-file` 时强制访问码，只转发公网 HTTPS 目标；密钥保存在系统凭据库（WP）或浏览器本地存储（Web 版），不会出现在智能体可读的文件系统里。

## 许可证

MIT，见 [LICENSE](LICENSE)。上游 DeepSeek Harness 版权 © 2026 DeepSeek（MIT）；第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。“DeepSeek Harness”是 DeepSeek 的注册商标；本项目是非官方移植，应用本身以 “DSH Mobile” 命名，与 DeepSeek 无隶属或背书关系。
