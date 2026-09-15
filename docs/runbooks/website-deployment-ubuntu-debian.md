# Ubuntu / Debian 简明部署

代码已自行 clone，使用当前登录用户即可。以下命令使用 Bash，除 SSH 隧道命令外，都在服务器的官网项目根目录执行。

## 1. 安装 Node.js 和 pnpm

要求 **Node.js 24**、**pnpm 11.19.0**。已有这两个版本可跳过安装。

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates libatomic1
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
npm install --global pnpm@11.19.0
```

这里用 [nvm 官方安装方式](https://github.com/nvm-sh/nvm#install--update-script) 将 Node.js 安装到当前用户目录。确认版本：

```bash
node --version
pnpm --version
```

## 2. 安装依赖并构建

```bash
pnpm install --frozen-lockfile --prod=false
pnpm check
pnpm build
```

每条命令成功后再执行下一条。构建需要开发依赖，不能只安装生产依赖。

## 3. 修改配置

编辑项目内的 `config/website.json`，默认内容如下：

```json
{
  "schemaVersion": 1,
  "websiteUrl": "http://127.0.0.1:4173",
  "host": "127.0.0.1",
  "port": 4173,
  "releaseDirectory": "../.runtime/website-releases",
  "contentDirectory": "../.runtime/website-content",
  "adminPasswordEnv": "DSH_OPS_WEBSITE_ADMIN_PASSWORD"
}
```

- `host`、`port`：监听 IP 和端口，默认仅本机可访问。
- `websiteUrl`：实际访问地址，管理员登录会校验协议、地址和端口；修改端口时同步修改。
- 两个数据目录可保持默认，不需要手动创建。

受控公司内网需要直接通过服务器 IP 访问时，可改为：

```json
"websiteUrl": "http://7.192.170.132:4173",
"host": "7.192.170.132",
"port": 4173
```

替换成服务器实际网卡 IP，并允许需要访问的内网电脑连接 TCP 4173。`websiteUrl` 使用纯 URL；`host` 也可用 `0.0.0.0` 监听所有 IPv4 网卡，但浏览器仍应使用实际 IP。HTTP 不加密传输；公网部署使用 HTTPS 网关。配置 HTTPS 地址本身不会让 Node 自动提供 TLS。

如果设置了 `DSH_OPS_WEBSITE_CONFIG`，则使用该变量指定的配置文件。配置修改后需重启服务。

## 4. 设置管理员密码并启动

在启动服务的同一个终端输入密码，要求 **16–256 个字符**。输入不会回显，不要把密码写进配置文件。

```bash
set +x
IFS= read -r -s -p '管理员密码（16–256 个字符）：' DSH_OPS_WEBSITE_ADMIN_PASSWORD
printf '\n'
export DSH_OPS_WEBSITE_ADMIN_PASSWORD
pnpm start
```

前台运行时，按 `Ctrl+C` 停止。密码只在当前终端环境中生效，新终端需要重新设置；程序不会自动读取 `.env`。

需要退出 SSH 后继续运行时，先设置上述密码，再用以下命令**替代** `pnpm start`，不要同时启动两份服务：

```bash
mkdir -p .runtime
nohup node dist/server/main.js >> .runtime/website.log 2>&1 < /dev/null &
printf '后台进程 PID：%s\n' "$!"
```

日志保存在 `.runtime/website.log`。后台停止前先核对输出的 PID 对应本项目，再用 `kill` 停止；此方式不提供开机自启，机器重启后重新设置密码并启动。

## 5. 检查与访问

在服务器另一个终端执行；改过端口时替换下面的端口：

```bash
curl --fail http://127.0.0.1:4173/health
```

返回 `{"status":"ok"}` 即服务已启动。

如果监听的是指定内网 IP，把健康检查地址换成 `http://7.192.170.132:4173/health`，并直接在同事的浏览器打开 `http://7.192.170.132:4173/` 或 `/admin`，无需 SSH 隧道。

- 官网：`http://127.0.0.1:4173/`
- 管理后台：`http://127.0.0.1:4173/admin`

保留默认 loopback 配置、希望从自己的电脑访问远程服务器时，在自己的电脑执行（替换用户名和服务器 IP，本机 4173 需空闲）：

```bash
ssh -N -L 4173:127.0.0.1:4173 USER@SERVER_IP
```

保持 SSH 隧道运行，再用浏览器打开上面的 loopback 地址。官网和使用共享发布协议 0.1.1 的 Desktop 均支持显式 HTTP 官网；客户端的 `ops-workbench.config.websiteUrl` 必须与官网对外地址一致。旧安装包仍保留 HTTPS / loopback 限制，需先升级客户端，不能仅修改官网配置。

在线文档、图片和发布包默认保存在项目的 `.runtime` 中，升级或重新部署时保留该目录。更多内容操作见 [维护手册](website-guide-maintenance.md)。
