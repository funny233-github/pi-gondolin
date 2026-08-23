# vm-config.jsonc 配置参考

> `vm-config.jsonc` 就是 `VM.create()` 的参数(基于 gondolin 的 `VMOptions` 类型),除 `mounts` / `secrets` 两个扩展字段外全部**原样透传**。
> 支持 JSONC 注释(`//` 和 `/* */`)与 `${VAR}` 环境变量插值。

---

## 快速上手

```jsonc
{
  "memory": "6G",
  "cpus": 8,
  "rootfs": { "size": "4G" },
  "sandbox": { "imagePath": "workspace:latest" },
  "mounts": ["/home/user/Work:/Work"],
  "ssh": { "allowedHosts": ["github.com"] },
  "tcp": { "game-gw:80": "127.0.0.1:8787" }
}
```

---

## 字段总览

| 分组 | 字段 |
|---|---|
| 资源 | `memory` `cpus` |
| 磁盘 | `rootfs` |
| 镜像/后端 | `sandbox` |
| 网络 | `dns` `ssh` `tcp` `allowWebSockets` `maxHttpBodyBytes` `maxHttpResponseBodyBytes` |
| 文件/环境 | `vfs` `env` |
| 生命周期 | `autoStart` `startTimeoutMs` `sessionLabel` |
| 扩展 | `mounts` `secrets` |

---

## 基础资源

### `memory` — 内存
- 类型:`string`(QEMU 语法,支持 `K`/`M`/`G`/`T` 后缀)
- 默认:`"1G"`(gondolin 默认),本项目模板 `"6G"`

```jsonc
"memory": "6G"
```

### `cpus` — CPU 核心数
- 类型:`number`
- 默认:`2`(gondolin 默认),本项目模板 `8`

```jsonc
"cpus": 8
```

---

## 磁盘

### `rootfs` — rootfs 配置
- 类型:`{ mode?, size? }`

| 子字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `"readonly" \| "memory" \| "cow"` | `"cow"` | 写入模式:`cow`(写时复制,落盘)、`memory`(纯内存)、`readonly` |
| `size` | `string \| number` | 镜像原始大小 | **最小磁盘大小**("至少"语义),支持后缀;启动时 `qemu-img resize` + guest 内 `resize2fs`,**镜像需含 e2fsprogs-extra** |

```jsonc
"rootfs": { "size": "4G" }
// 或: "rootfs": { "mode": "memory", "size": "2G" }   // 纯内存盘
```

---

## 镜像与后端(`sandbox`)

> `sandbox` 是 `SandboxServerOptions`。顶层多数字段会自动转发到这里(`ssh`/`tcp`/`dns`/`memory`/`cpus`/`allowWebSockets`...),所以一般只需关心镜像相关子字段。

### `sandbox.imagePath` — 镜像
- 类型:`string`(镜像引用)
- 可接受:镜像 `ref`(`name:tag`)、build id、资产目录路径、guest assets 对象
- 默认:`GONDOLIN_DEFAULT_IMAGE` env,再缺省 `alpine-base:latest`

```jsonc
"sandbox": { "imagePath": "workspace:latest" }
```

### `sandbox.vmm` — 虚拟机后端
- 类型:`"qemu" | "krun"`
- 默认:`"qemu"`(或 `GONDOLIN_VMM` env)

### 其他常见子字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `machineType` | `string` | QEMU machine 类型(如 `"q35"`) |
| `accel` | `string` | 加速器(默认自动:KVM/HVF,不可用时 TCG) |
| `cpu` | `string` | QEMU CPU 模型(如 `"host"`;可用 `GONDOLIN_CPU` env) |
| `console` | `"stdio" \| "none"` | 控制台模式 |
| `autoRestart` | `boolean` | 崩溃后自动重启 |
| `rootDiskReadOnly` | `boolean` | 根盘只读 |

```jsonc
"sandbox": {
  "imagePath": "workspace:latest",
  "vmm": "qemu",
  "cpu": "host"
}
```

---

## 网络

### `dns` — DNS 模式
- 类型:`{ mode?, trustedServers?, syntheticIPv4?, syntheticIPv6?, syntheticTtlSeconds?, syntheticHostMapping? }`

| 子字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `"open" \| "trusted" \| "synthetic"` | `"synthetic"` | synthetic = host 拦截 DNS 并映射到合成 IP(SSH/tcp 代理必需) |
| `trustedServers` | `string[]` | — | 可信解析器 IP(`mode="trusted"`) |
| `syntheticIPv4` | `string` | — | 合成 A 记录 IP |
| `syntheticIPv6` | `string` | — | 合成 AAAA 记录 IP |
| `syntheticTtlSeconds` | `number` | — | 合成记录 TTL |
| `syntheticHostMapping` | `"single" \| "per-host"` | — | 映射策略(`tcp` 需要 `per-host`) |

一般不需要配(默认 synthetic 即可),`tcp` 映射会自动处理。

### `ssh` — SSH 出站代理
- 类型:`{ allowedHosts?, credentials?, agent?, knownHostsFile?, hostKey? }`(函数型字段如 `hostVerifier`/`execPolicy` 不可 JSON 表达)

| 子字段 | 类型 | 说明 |
|---|---|---|
| `allowedHosts` | `string[]` | 允许 ssh 出站的主机模式,支持 `:PORT` 后缀与通配符 |
| `agent` | `string` | 宿主机 ssh-agent socket 路径(本项目自动从 `$SSH_AUTH_SOCK` 补充,可用 `${SSH_AUTH_SOCK}` 插值) |
| `knownHostsFile` | `string \| string[]` | 上游主机指纹校验文件(自动补 `~/.ssh/known_hosts`) |
| `credentials` | 对象 | 按主机指定的私钥(`{ host: { username, privateKey } }`;JSON 里可写 `privateKey` 为字符串) |

> **无 agent 时整个 ssh 功能自动关闭**(VM 正常启动,只是没有 ssh 代理)。

```jsonc
"ssh": {
  "allowedHosts": ["github.com", "*.github.com", "my-server.com:2222"],
  "agent": "${SSH_AUTH_SOCK}"
}
```

### `tcp` — 假域名 → host 端口映射
- 类型:`{ hosts: Record<string, string> }`
- guest 访问 `host[:port]` → 转发到 `upstream:port`(需要 synthetic DNS,默认已开启)

```jsonc
"tcp": {
  "game-gw:80": "127.0.0.1:8787"   // VM 里 http://game-gw/... → host 网关
}
```

### `allowWebSockets` — WebSocket 升级
- 类型:`boolean`;默认 `true`

### `maxHttpBodyBytes` / `maxHttpResponseBodyBytes` — HTTP 体积上限
- 类型:`number`(bytes)
- 默认:各有内置上限;超限请求/响应会被拦截

---

## 文件与环境

### `vfs` — 虚拟文件系统
- 类型:`{ mounts?, hooks?, fuseMount? }`
- **注意**:`mounts` 需要 `VirtualProvider` 对象(JSON 表达不了),本项目用扩展字段 `mounts`(字符串数组)代替,扩展自动转换

```jsonc
"vfs": { "fuseMount": "/data" }   // 若需调整 FUSE 挂载点
```

### `env` — 注入 VM 的环境变量
- 类型:`string[] | Record<string, string>`
- 支持 `${VAR}` 插值;**注意:这里注入的是真值,VM 里可见**

```jsonc
"env": { "MODE": "dev", "TOKEN": "${MY_TOKEN}" }
```

---

## 生命周期

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoStart` | `boolean` | `true` | 创建后立即启动 |
| `startTimeoutMs` | `number` | 内置 | guest 就绪等待超时(ms) |
| `sessionLabel` | `string` | — | `gondolin list` 里显示的会话标签 |

---

## 扩展字段(仅本项目)

### `mounts` — 额外挂载
- 类型:`string[]`,每项 `"hostPath:guestPath"` 或裸 `"hostPath"`(自动挂 `/mnt/<basename>`)
- host 路径不存在则跳过并警告

```jsonc
"mounts": ["/home/user/Work:/Work", "/home/user/data"]
```

### `gitIdentity` — 继承宿主 git 身份
- 类型:`boolean`;默认 `true`
- 扩展在宿主机读取 `user.name`/`user.email`,以 `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` 环境变量注入 VM
- 这样 VM 里 `git commit` 显示的是你自己的身份,而不是 root/默认账号

```jsonc
"gitIdentity": true    // 或 false 关闭
```

### `secrets` — HTTP 密钥注入
- 类型:`{ NAME: { hosts: string[], valueFromEnv: string } }`
- VM 里只见占位符;出站 HTTP 到 `hosts` 内域名时由 host 替换为真值(`valueFromEnv` 指向宿主机环境变量)

```jsonc
"secrets": {
  "GAME_API_KEY": { "hosts": ["api.game.com"], "valueFromEnv": "GAME_API_KEY" }
}
```

---

## 不可 JSON 表达的字段(无法写入配置)

以下字段是函数/对象实例,配置里写了会被忽略或报错:

- `fetch`(自定义 HTTP 下载实现)
- `httpHooks`(HTTP 拦截钩子;由 `secrets` 扩展代替)
- `ssh.hostVerifier` / `ssh.execPolicy`(回调函数)
- `debugLog`(回调)
- `vfs.hooks` / `vfs.mounts`(provider 对象)

---

## 完整示例(网关 + SSH + 多挂载)

```jsonc
{
  // 资源
  "memory": "6G",
  "cpus": 8,
  "rootfs": { "size": "4G" },

  // 镜像
  "sandbox": { "imagePath": "workspace:latest" },

  // SSH 出站(agent 自动)
  "ssh": {
    "allowedHosts": ["github.com", "my-server.com"],
    "agent": "${SSH_AUTH_SOCK}"
  },

  // 游戏网关:VM 里 http://game-gw/... → host 127.0.0.1:8787
  "tcp": { "game-gw:80": "127.0.0.1:8787" },

  // 挂载
  "mounts": ["/home/user/Work:/Work", "/home/user/data"],

  // 注入环境变量
  "env": { "LOG_LEVEL": "info" },

  // 密钥注入(防被动窃取;主动 AI 建议走网关)
  "secrets": {
    "GAME_API_KEY": { "hosts": ["api.game.com"], "valueFromEnv": "GAME_API_KEY" }
  }
}
```
