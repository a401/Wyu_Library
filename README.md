# WYU Library MCP

五邑大学图书馆统一检索与文献传递的本地 MCP 服务，使用 Node.js + Playwright，通过 stdio 接入支持 MCP 的客户端。

支持关键词/题名/DOI 检索、候选论文匹配、详情查询、登录、文献传递和链接下载。检索通常无需登录；文献传递需要使用者自己的有效校园账号及相应权限。本项目非学校官方服务，接口和验证规则可能随网站更新而变化。

## 1. 安装

需要 Node.js 22 或更高版本、npm，以及可访问图书馆网站的网络。

```bash
git clone https://github.com/a401/Wyu_Library.git
cd Wyu_Library
npm ci
npx playwright install chromium
npm run doctor
```

默认优先使用系统 Microsoft Edge，失败后回退到 Playwright Chromium；已有可用 Edge 时可跳过 Chromium 安装。Linux 缺少系统库时可用 `npx playwright install --with-deps chromium` 安装依赖。手动登录需要桌面图形环境。

## 2. 接入 MCP 客户端

将路径替换为你克隆项目后的**绝对路径**。Windows 可写成 `C:/projects/Wyu_Library/src/server.js`；macOS/Linux 使用对应的 `/.../Wyu_Library/src/server.js`。若客户端找不到 `node`，也将 `command` 改为 Node 可执行文件的绝对路径。

支持 `mcpServers` 的客户端配置：

```json
{
  "mcpServers": {
    "wyu-library-access": {
      "command": "node",
      "args": ["/absolute/path/to/Wyu_Library/src/server.js"]
    }
  }
}
```

Codex 可在 `~/.codex/config.toml` 中添加（不要覆盖其他配置）：

```toml
[mcp_servers.wyu-library-access]
command = "node"
args = ["/absolute/path/to/Wyu_Library/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

配置格式参考 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。保存后重启 MCP 连接/客户端。文献传递可能等待数分钟，其他客户端也应相应调高工具超时。服务由客户端启动；`npm start` 仅用于手动启动 stdio 服务，不提供网页界面。

## 3. 登录与可选配置

只检索可跳过登录。文献传递前在项目目录运行：

```bash
npm run login
```

在弹出的浏览器中完成自己的校园统一认证和验证，成功后窗口自动关闭。也可在 MCP 客户端调用 `open_login`，完成后调用 `login_status`。请勿让登录助手和另一个 MCP 进程同时占用同一浏览器目录。

需要默认收件邮箱或自动登录时，将 `.env.example` 复制为项目根目录下的 `.env`，按需填写。例如：

```dotenv
WYULIB_DELIVERY_EMAIL=reader@example.com
# 可选；不填账号密码也可使用手动登录
WYULIB_USER=
WYULIB_PASS=
```

每行一个变量；密码含 `#`、空格等字符时用引号包裹。环境变量优先于 `.env`，服务、登录助手和诊断命令共用这份配置。

- `WYULIB_USER` / `WYULIB_PASS`：自己的账号密码。两者配置后默认允许自动登录，设 `WYULIB_AUTO_LOGIN=0` 可禁用。
- `WYULIB_DELIVERY_EMAIL`：默认收件邮箱，也可每次调用工具时提供。
- `WYULIB_BROWSER_CHANNEL`：默认 `msedge`，也可指定已安装的 `chrome`。
- `WYULIB_BROWSER_PROFILE` / `WYULIB_DOWNLOAD_DIR`：默认 `browser-profile/`、`downloads/`，相对路径按项目根目录解析。
- `WYULIB_ASSIST_CAPTCHA_DEFAULT=0`：禁用文献传递滑块辅助，需手动验证时用 `interactive=true`、`assistCaptcha=false`。此开关不控制 CAS 自动登录，手动认证请另设 `WYULIB_AUTO_LOGIN=0`。

滑块辅助仅尝试操作页面控件，不保证验证成功。遇到验证码、账号异常或权限限制，请按网站要求手动处理，不绕过访问限制。

## 常用工具

| 工具 | 用途 |
| --- | --- |
| `search_literature` | 按关键词、题名、作者等检索 |
| `find_best_literature` | 根据题名/DOI 筛选并排序候选论文 |
| `get_literature_detail` | 查询检索结果中某条记录的详情 |
| `open_login` / `login_status` | 手动登录 / 检查或恢复登录 |
| `request_document_delivery` | 获取文献传递链接，不提交申请 |
| `submit_document_delivery` | 向指定邮箱提交真实的文献传递申请 |
| `download_url` | 将用户提供的下载链接保存到本地 |

示例对话：“在五邑大学图书馆搜索 large language models，列出前 5 篇论文。”需要传递时先核对论文与收件邮箱，再明确要求提交。只有调用 `submit_document_delivery` 才会提交申请；默认滑块辅助可能自动完成提交。`download_url` 不会读取你的邮箱，需自行提供收到的下载链接。

## 隐私与排查

- 仓库仅包含源码、依赖清单、测试及说明，不包含账号、密码、Cookie、个人邮箱、登录数据或下载的文献。
- `.env` 是本机明文配置；`browser-profile/` 保存 Cookie、缓存及其他浏览器会话数据，均不可分享。仓库已忽略这些默认目录；使用自定义目录时也请放在仓库外或自行加入 `.gitignore`。
- 工具结果可能包含当前登录用户名、邮箱、带授权参数的传递链接和本机路径；提交 issue 或分享日志前请脱敏。
- 浏览器缺失：运行 `npm run doctor`，或重新安装 Chromium。配置目录被占用：关闭本服务启动的浏览器并停止占用它的 MCP 进程，再重试。
- 登录失效：重新运行 `npm run login`。网站不可达/接口变化：先确认浏览器能正常访问图书馆；检索权限、全文权限与文献传递规则以图书馆为准。
- 本地检查：`npm run check`、`npm test`。测试不使用真实账号、不提交申请。

请仅使用自己的合法访问权限，遵守学校服务条款和文献版权要求，不批量滥用接口或公开传播受限全文。
