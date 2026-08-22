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
npm run install        # 安装依赖 + 注册到 ~/.pi/agent/extensions/gondolin/
npm run uninstall      # 移除已安装的扩展文件
npm run config-init    # 从模板重新生成 vm-config.jsonc(覆盖前备份为 .bak)
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

## 配置文件(vm-config.jsonc)

VM 参数统一由 `vm-config.jsonc` 管理(`npm run install` 首次自动生成;改配置后**重启 pi** 生效)。

**`vm-config.jsonc` 就是 `VM.create()` 的参数**——除了 `mounts` 和 `secrets` 两个 JSON 无法直接表达的部分(字符串数组 → vfs provider、定义 → http hooks),其余字段全部原样透传给 `VM.create`。

| 字段 | 说明 | 默认 |
|---|---|---|
| `memory` | 内存(透传) | `6G` |
| `cpus` | CPU 数(透传) | `8` |
| `rootfs.size` | rootfs 大小(镜像需含 resize2fs/e2fsprogs-extra) | `4G` |
| `sandbox.imagePath` | 镜像 | `workspace:latest` |
| `ssh.allowedHosts` | SSH 出站白名单(agent 自动从 `$SSH_AUTH_SOCK` 补充) | `github.com` |
| `tcp` | guest 假域名 → host 端口映射(如 `"game-gw:80": "127.0.0.1:8787"`) | 无 |
| `env` | 注入 VM 的环境变量 | `{}` |
| `mounts` | 额外挂载数组,`"host[:guest]"` 格式,裸路径自动挂 `/mnt/<名字>` | `[]` |
| `secrets` | HTTP 密钥注入:`{ "NAME": { "hosts": [...], "valueFromEnv": "ENV" } }` | `{}` |

> 任何 `VM.create` 支持的选项都能写进配置(如 `dns`、`allowWebSockets` 等),扩展会把配置整体透传。

示例:

```json
{
  "memory": "6G",
  "cpus": 8,
  "rootfs": { "size": "4G" },
  "sandbox": { "imagePath": "workspace:latest" },
  "mounts": ["/home/user/Work:/Work", "/home/user/data"],
  "ssh": { "allowedHosts": ["github.com", "my-server.com"] },
  "tcp": { "game-gw:80": "127.0.0.1:8787" },
  "env": { "MY_FLAG": "1" },
  "secrets": {
    "GAME_API_KEY": { "hosts": ["api.game.com"], "valueFromEnv": "GAME_API_KEY" }
  }
}
```

> - **支持注释(JSONC)**:配置里可以写 `//` 行注释和 `/* */` 块注释(字符串内的 `//` 不受影响),生成的 `vm-config.jsonc` 自带字段说明
> - **环境变量插值**:配置里任何字符串支持 `${VAR}` 写法,加载时替换为宿主机同名环境变量的值(深递归,数组/对象内也生效)。例如 `"agent": "${SSH_AUTH_SOCK}"`。
> - `vm-config.jsonc` 已被 gitignore(本地配置);`vm-config.example.json` 是提交的模板
> - 密钥类字段只填**环境变量名**(`valueFromEnv`),真值放在宿主机环境变量里,不进代码、不进配置
> - `secrets` 占位符由 host 在出站 HTTP 时替换,只对 `hosts` 内的域名生效

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
