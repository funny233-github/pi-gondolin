# pi-gondolin

在 [Gondolin](https://github.com/earendil-works/gondolin) 微 VM 里运行 [pi](https://github.com/earendil-works/pi-coding-agent) 的扩展:所有 `read`/`write`/`edit`/`bash` 工具都在隔离的 Linux VM 中执行,宿主机项目目录通过 sandboxfs 挂载进 VM。

## 特性

- **隔离运行**:工具在 VM 中执行,与宿主机隔离
- **SSH 出站代理(egress proxy)**:guest 可 ssh/git 到白名单主机,认证在宿主机通过 ssh-agent 完成,**私钥永不进入 VM**
- **多目录挂载**:通过 `GONDOLIN_MOUNTS` 挂载任意多个宿主目录
- **动态磁盘扩容**:`rootfs.size` 在启动时按需扩容(镜像内需含 `resize2fs` / `e2fsprogs-extra`)
- **资源可配**:内存 / CPU / rootfs 大小

## 安装 / 卸载

```bash
npm run install      # 安装依赖 + 注册到 ~/.pi/agent/extensions/gondolin/
npm run uninstall    # 移除已安装的扩展文件
```

`npm run install` 会把 `index.ts` 复制到 `~/.pi/agent/extensions/gondolin/` 并链接 `node_modules`,重启 pi 后生效。

## 使用

### 方式一:自动加载(推荐)

```bash
npm run install
# 重启 pi,扩展自动生效
```

### 方式二:显式指定

```bash
npx -y @earendil-works/pi-coding-agent -e /pi-gondolin/index.ts
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `GONDOLIN_DEFAULT_IMAGE` | 使用的镜像(如 `workspace:latest`) | `alpine-base:latest` |
| `SSH_AUTH_SOCK` | 宿主机 ssh-agent socket;**未设置则 SSH 功能整体关闭** | 无 |
| `GONDOLIN_SSH_ALLOW_HOSTS` | 允许 ssh 出站的主机,逗号分隔 | `github.com` |
| `GONDOLIN_MOUNTS` | 额外挂载,分号分隔 `host[:guest]`,裸路径自动挂到 `/mnt/<名字>` | 无 |

示例:

```bash
export GONDOLIN_DEFAULT_IMAGE=workspace:latest
export SSH_AUTH_SOCK="$XDG_RUNTIME_DIR/ssh-agent.socket"
export GONDOLIN_SSH_ALLOW_HOSTS="github.com,my-server.com"
export GONDOLIN_MOUNTS="/home/user/Work:/Work;/home/user/data"
npx -y @earendil-works/pi-coding-agent -e /pi-gondolin/index.ts
```

VM 内挂载结果:`/workspace`(启动目录)、`/Work`、`/mnt/data`。

## 注意事项

- **挂载目录的 exec 位会丢失**(sandboxfs 限制):可读写文件,但编译/运行二进制请放到 root 磁盘(如 `/tmp`)
- **SSH 只支持非交互 exec 通道**:`git clone/push`、`ssh user@host "cmd"` 可用;交互式 shell 与 sftp 被代理拒绝
- **guest 内 host key 校验已跳过**:扩展自动注入 `GIT_SSH_COMMAND`,git 无需额外配置;真实主机校验由宿主机 `known_hosts` 完成
- **私钥保管**:仅使用宿主机 ssh-agent,私钥文件不进入 VM

## 依赖

- Node.js >= 23.6
- QEMU(或 krun)
- Gondolin 镜像(默认 `alpine-base:latest`,或自定义 `workspace:latest`)
