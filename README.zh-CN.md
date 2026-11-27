# Rokku CLI

[English](README.md)

在终端、Claude Code 和 Codex 里使用你的 [Rokku](https://www.rokku.ai) 账号。

Rokku 是 iPhone 上的个人 AI 助手。装上这个 CLI 后，电脑上的编程 Agent 能帮你：

- 做和改 Rokku 作品（首页上的小应用）
- 管理首页、主题、定时任务、连接器和模型 Key
- 把其他事交给你的 Rokku Agent 去办

所有改动都落在同一个账号里，手机上马上能看到。

- 没有依赖，需要 Node.js 20.11 或更新版本。
- 可以直接在命令行里用，也可以作为 Claude Code 技能、Codex 说明或 MCP 服务使用。
- MIT 许可证。

## 能做什么

| 类别 | 例子 |
| --- | --- |
| 作品 | 新建；拉取源码、检查、推送新版本；看版本历史、回滚到旧版本；放进回收站和恢复；公开链接；用量 |
| 作品数据 | 读写作品里存的数据，等待或监听数据变化 |
| 首页 | 放上、拿下、排序、改尺寸 |
| 主题 | 查看、保存、应用、切换、撤销 |
| 定时任务和任务 | 新建、修改、暂停、删除定时任务；查看任务、追加消息、取消任务 |
| 连接器和 Key | 连接第三方服务（OAuth 在浏览器里完成）；删除连接；查看和停掉作品收到的连接器事件；添加自带的模型 Key；切换 Rokku 用的模型或模式；查看 Key 的余额 |
| 聊天、记忆和账户 | 读、搜索、删除聊天消息；只读查看 Rokku 记住的内容；查看套餐和额度；导出账号 |
| 你的 Rokku Agent | `rokku ask` 发消息并实时显示回复。没有直接命令的事都能交给它，包括在手机上才能做的事（日历、提醒、照片等）；需要你确认时，卡片会出现在手机上 |

在电脑上改了作品，你的 Rokku Agent 也会知道：每个版本都附一句改动说明，首页的变化也会记下来。在手机上问它「我刚才在电脑上改了什么？」就能得到回答。

## 安装

```bash
git clone https://github.com/sevenfloor7/rokku-cli
npm install -g ./rokku-cli
```

更新：

```bash
git -C rokku-cli pull && npm install -g ./rokku-cli
```

卸载：`npm uninstall -g rokku-cli`。

## 登录

```bash
rokku login
```

输入 Rokku 邮箱和收到的验证码。这台电脑会作为一台单独的设备登录，手机不会被登出。在 Rokku App 的设备列表里，它显示为「Rokku CLI on 你的电脑名」，可以在那里撤销，也可以运行 `rokku logout`。

确认登录成功：

```bash
rokku whoami
```

## 接入编程 Agent

### Claude Code

在 clone 仓库的那个目录里运行，安装技能：

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/rokku-cli/skills/rokku" ~/.claude/skills/rokku
```

或者把 CLI 作为 MCP 工具接入：

```bash
claude mcp add rokku -- rokku mcp
```

### Codex

把 `agents/AGENTS.md` 的内容追加到 `~/.codex/AGENTS.md`（或项目里的 `AGENTS.md`），或者添加 MCP 服务：

```bash
codex mcp add rokku -- rokku mcp
```

Codex 有两项设置要注意：

- 如果 MCP 服务的 `env` 里设置了 `PATH`，它必须包含 `node` 所在的目录，否则工具不会出现，也不会报错。
- `codex exec` 需要给这个服务设置 `default_tools_approval_mode = "approve"`。默认值 `never` 会拦掉所有工具调用。

### 其他 MCP 客户端

把 `rokku mcp` 作为 stdio 服务运行。

## 快速示例

```bash
rokku creations                                   # 列出作品
rokku pull "Reading List" ./reading-list          # 下载源码
#   ……改文件，或者让编程 Agent 来改……
rokku push "Reading List" ./reading-list --note "按月份给书分组"
rokku home add "Reading List" --size m            # 放上首页
rokku ask "晚上把主题调得暖一点"                    # 交给 Rokku Agent 去办
```

运行 `rokku help` 查看全部命令和参数。完整的命令清单见[英文说明](README.md#commands)。

`<creation>` 可以是作品 id 或标题。读取时可以只写标题的一部分；写入时必须写完整标题，这样作品改名后，不会把数据写错到别的作品里。

## 必须你本人做的事

下面这些步骤是故意留给你、不交给编程 Agent 的：

- **登录：** Agent 会请你自己运行 `rokku login`。
- **回答卡片：** Rokku 需要你做选择、确认或授权时，你在手机上答，或者在自己的终端里运行 `rokku answer <id>`。Agent 只会告诉你卡片在问什么。
- **密钥：** Key、token 和连接器凭据只能从隐藏输入或标准输入读取，不能写在命令参数里。通过 MCP 调用时，需要密钥的命令会拒绝，并请你自己在终端里运行。
- **无法撤销的操作：** 删除主题、定时任务、连接或 Key 前会先确认。脚本里用 `--yes` 跳过确认；MCP 工具调用可以传 `yes`，因为 Agent 调用工具前会先问你。

CLI 使用和 Rokku App 一样的全权限账号会话，请只在自己的电脑上使用。权限更窄的登录方式在计划中。

在 macOS 上，登录凭据存在系统钥匙串里（条目名「rokku-cli」）。其他系统，或者设置了 `ROKKU_TOKEN_STORE=file` 时，存在 `~/.config/rokku/config.json`，文件权限是 0600。

## 费用

CLI 本身和编程 Agent 自己的用量不算 Rokku 的额度。Rokku 替你做的事和在 App 里一样计入 Rokku 用量，包括 `rokku ask` 的回复和它开启的任务，以及部署、运行你的作品。

## 常见问题

- **`rokku: command not found`：** npm 的全局 bin 目录不在 `PATH` 里。运行 `npm prefix -g`，把它下面的 `bin` 目录加进 `PATH`。
- **在代理后面：** 在 Node 22.21+ 和 24+ 上，CLI 会使用 `HTTPS_PROXY` / `HTTP_PROXY`。更老的 Node 用不了代理，连不上 Rokku 时会说明。
- **推送时提示作品已经变了：** 有人或你的 Rokku Agent 发布了更新的版本。先重新 `rokku pull`，再把你的改动加上去。

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
