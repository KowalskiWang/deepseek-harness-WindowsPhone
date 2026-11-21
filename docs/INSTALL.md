# 安装与部署 DSH Mobile

DSH Mobile 有两种形态，代码完全相同：

| 形态 | 适用 | 安装方式 |
|---|---|---|
| **局域网 Web 版**（推荐先用） | Windows Phone 8.1 / Windows 10 Mobile / 任意浏览器 | 手机浏览器打开 Mac 上网关的地址，固定到开始屏幕 |
| **APPX 原生应用包** | Windows Phone 8.1、Windows 10 Mobile | WP8.1 需 Windows 电脑部署；W10M 开发者模式可直接安装 |

> **真机验证（2026‑11‑22）**：Nokia Lumia 1020（`Nokia 909`，Windows Phone 8.1，IE Mobile 11）上的局域网 Web 版已跑通——启动与首次引导、模型列表、流式对话、自动标题、文件写入/读取、`run_code`（Web Worker 沙箱）、联网搜索。APPX 版尚未在真机安装验证（WP8.1 需要 Windows 电脑部署）。

> **为什么需要网关？** Windows Phone 8.1 的系统 TLS（Windows 8.1 schannel）不支持 `api.deepseek.com` 及大多数现代 HTTPS 站点要求的 ECDHE‑RSA‑AES‑GCM 加密套件（已实测：服务器只接受这类套件）。所以 WP8.1 上的应用通过同一 Wi‑Fi 下电脑运行的 DSH 网关转发 HTTPS 请求。Windows 10 Mobile 可以直连，网关可选。

---

## 1. 在电脑上启动网关（Mac / Linux / Windows，需 Node.js 18+）

```bash
cd lumiaDSH
npm install
npm run build
node gateway/server.mjs --key-file api.txt
```

启动后终端会打印：

```
DSH gateway 0.2.2
  open on the phone (same Wi-Fi):  http://192.168.1.100:8787/
  API key    : injected from api.txt (sk-xx…xxxx)
  access code: 123456
```

- `--key-file api.txt`：网关从文件读取 DeepSeek API Key 并在转发到 api.deepseek.com 时注入，**密钥不会经过 Wi‑Fi 传给手机**。此时网关强制要求 6 位**访问码**（每次启动随机生成，可用 `--code 135790` 固定）。
- 不带 `--key-file`：网关只做透明转发，手机端需在“设置 → 模型”里自己填 API Key（会以明文 HTTP 经过局域网，仅建议在可信网络使用）。
- `--port 8787`、`--host 0.0.0.0`、`--proxy http://127.0.0.1:1082`（上游走 HTTP 代理）可选。
- macOS 首次运行可能弹出“是否允许 node 接受传入连接”，请选择**允许**，否则手机连不上。
- 网关只转发 `https://` 公网地址，拒绝内网/本机目标，并跟随重定向（手机无法自己跟随到现代 HTTPS 站点）。

## 2. 局域网 Web 版（WP8.1 立刻可用）

1. 手机和电脑连同一个 Wi‑Fi。
2. 手机上打开 **Internet Explorer**，访问终端里打印的地址，例如 `http://192.168.1.100:8787/`。
3. 首次打开会显示“预览说明”，然后是“添加一个 API Key 开始使用”：网关地址已自动填好，输入终端里的**访问码**，API Key 留空（由网关提供），点“保存并继续”。
4. 在 IE 菜单中选择 **固定到“开始”屏幕**，之后从开始屏幕的磁贴启动，体验接近原生应用。
5. 页面使用 AppCache 缓存，网关短暂离线时界面仍可打开；对话需要网关在线。
6. 数据（会话、工作区文件、设置）保存在手机 IE 的 IndexedDB 中。清除 IE 浏览数据会删除它们。

## 3. APPX 原生应用

构建（已在 `dist/package/` 生成好）：

```bash
sh scripts/package-appx.sh
```

产物：

- `dist/package/DSHMobile_0.2.2.0_neutral.appx` — 已签名（`CN=DSH Mobile` 自签名证书，SHA‑256）
- `dist/package/DSHMobile.cer` — 签名证书（公钥）
- 私钥在 `signing/`（不要分发；后续版本继续用它签名，才能覆盖安装）

网关启动后，手机也可以通过 `http://<电脑IP>:8787/download/` 下载这两个文件。

### 3a. Windows Phone 8.1

WP8.1 **不支持**从浏览器或文件管理器安装自签名 APPX，必须用 Windows 电脑通过 USB 部署：

1. 在 Windows 电脑安装 Windows Phone 8.1 开发工具（Visual Studio 2015 + “Windows Phone 8.1 Tools”，或旧版 Windows Phone SDK 8.1）。
2. 运行 **Windows Phone Developer Registration (8.1)**，用 USB 连接手机并“注册”（开发者解锁）。微软的解锁服务已停止维护，若注册失败，只能借助社区工具（如 Windows Phone Internals）解锁，风险自负。
3. 用 **Application Deployment 8.1** 图形工具，或命令行：
   ```bat
   "C:\Program Files (x86)\Microsoft SDKs\Windows Phone\v8.1\Tools\AppDeploy\AppDeployCmd.exe" /installlaunch DSHMobile_0.2.2.0_neutral.appx /targetdevice:de
   ```
4. 在应用里：设置 → 通用设置 → 网络网关，填 `http://<电脑IP>:8787` 和访问码，点“测试连接”。（WP8.1 上“HTTPS 走网关”默认自动开启。）

### 3b. Windows 10 Mobile

1. 设置 → 更新和安全 → 开发者选项 → 选择 **开发人员模式**。
2. 把 `DSHMobile.cer` 和 `.appx` 拷到手机（或用 Edge 打开 `http://<电脑IP>:8787/download/` 下载）。
3. 先打开 `DSHMobile.cer` 安装证书，再在“文件资源管理器”中点 `.appx` 安装；也可以用 Windows Device Portal（开发者选项里开启“设备门户”，电脑浏览器访问手机 IP → Apps → 安装）。
4. W10M 可直连 api.deepseek.com：在“设置 → 模型”填 API Key 即可；也可以继续使用网关。

## 4. 常见问题

| 现象 | 处理 |
|---|---|
| 手机打不开网关地址 | 确认同一 Wi‑Fi、macOS 防火墙已允许 node、地址用的是 `192.168.x.x` 而不是 `198.18.x.x` 这类代理虚拟网卡地址 |
| “网关: gateway access code required” | 访问码错误或网关重启后换了码；在设置 → 通用设置 → 网络网关里更新 |
| “API Key 无效 / 尚未配置” | 网关未带 `--key-file`，或手机端填写的 Key 有误 |
| 网页抓取失败 | WP8.1 上需要网关；或在“插件 → 联网搜索与抓取”改用 DeepSeek Fetch API |
| 想看日志 | 网关终端会逐行打印请求；会话日志可在聊天页“更多操作 → 下载 Session 日志”导出到工作区 `dsh-exports/` |
