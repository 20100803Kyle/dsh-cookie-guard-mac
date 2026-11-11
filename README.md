# dsh-cookie-guard-mac

> 修 DeepSeek Harness 桌面端「用着用着突然打不开、报 **Web authentication failed (431)**」。
> macOS 版；Windows 路径也兼容。

## 症状

桌面端启动几次、十几次之后，某次打开就白屏/报错：

```
HTTP ERROR 431
Web authentication failed
```

重启无效，换端口无效，清缓存也无效。

## 原因

桌面端每次启动都会用随机端口做登录鉴权（`http://127.0.0.1:<端口>`），每次都**新写一条** Cookie：

```
name = "dsh-auth-" + base64url(sha256("127.0.0.1:" + 端口))
```

端口变了名字就变，而这条 Cookie 的过期时间是几十天后（`expires_utc ≈ 2095`）。DSH 里没有任何清理逻辑，于是每启动一次就永久多一条。

攒到 **约 70 条** 时，请求里的 `Cookie:` 头超过 Node 默认的 16 KB 请求头上限，本地 Host 直接回 431，桌面端就报 `Web authentication failed`，从此再也进不去。

这台机器上的实测：`Cookies` 库里正好 **71 条** `dsh-auth-*`，总大小约 16 KB —— 和 431 的临界点完全对得上。

## 它做什么

不改 `app.asar`、不加启动器、不动快捷方式，只做一件事：

- DSH 启动时，插件 detach 一个后台清理器（`lib/cleaner.mjs`）；
- 清理器等 DSH 退出、Cookie 库真正解锁之后，删掉所有 `dsh-auth-*`，`VACUUM` 收尾，然后自己退出；
- 其他 Cookie、登录态、`Local Storage` 一概不碰。

下次启动就是干净的。清理器独立进程运行，所以 DSH 正常退出、崩溃、被 `kill` 掉了它都还能干活。

### macOS 的库在哪

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies` |
| Windows | `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` |

macOS 上主库就在 profile 根目录，没有 `Network/` 这一层；另外 `Partitions/<hash>/Cookies` 也会一起扫（通常是空的）。

### 为什么不用「试着重开数据库」

Windows 上 Cookie 库是强制锁，`open(db, 'r+')` 失败基本等于「DSH 还开着」。macOS 是 POSIX 建议锁，DSH 开着的时候别的进程一样能打开，判断会误杀。所以这里改成三条同时满足才动手：

1. 拉起清理器时记下的 Host pid / ppid 都已退出；
2. `pgrep -f --user-data-dir=<profile>` 没有残留进程（覆盖 Host 重启、pid 变化）；
3. Cookie 库的 mtime 已经稳定一段时间（没人在写）。

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-cookie-guard-mac
# 或装打包好的 tgz
dsh plugin --profile desktop add file:/path/to/dsh-cookie-guard-mac-0.1.1.tgz
```

装完**重启一次 DSH**，插件才会加载、清理器才会挂上。

## 用法

插件注册了一个工具 `cookie_guard`：

- `cookie_guard(action: "status")` —— 看 Cookie 库在哪、有几条 `dsh-auth-*`、离 16 KB 还有多远、清理器在不在跑；
- `cookie_guard(action: "clean")` —— DSH 正在跑就排到退出后清；已经退出就立刻清。

也可以完全不管它：启动时挂上、退出时清理，是自动的。

日志与 pid 文件：

```
<Cookies>.guard.log    # 清理器的记录
<Cookies>.guard.pid    # 运行中的 pid，超 90 秒没刷新视为残留
```

## 配置

`cordis.patch.yml` 里 `config` 可以填：

```yaml
- id: dsh-cookie-guard-mac
  name: dsh-cookie-guard-mac
  config:
    maxHours: 0   # 0 = 不限，DSH 开多久等多久；正数则按小时封顶
```

## 风险与取舍

- 删的是本机的登录 Cookie，**下一次启动会重新登录/重新发一条**，不影响账号本身；但如果你正开着 DSH 手动删库，会掉登录态（这也是为什么清理排在退出之后）。
- 只匹配 `name like 'dsh-auth-%'`，其他站点的 Cookie 不动。
- 依赖 Node 22.5+ 的 `node:sqlite`（DSH 桌面端自带 Node 24，满足）。
- 如果 Host 在清理器跑之前就重启了，多个清理器可能短暂并存——它们只会多清一次 0 条，无害。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-cookie-guard-mac
```

然后删掉 `<Cookies>.guard.log`、`<Cookies>.guard.pid` 即可。已经清掉的 Cookie 不会回来（本来也是垃圾）。

## License

MIT
