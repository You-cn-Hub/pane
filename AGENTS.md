# AGENTS.md · Pane 项目规则库

> 任何 AI 在本仓库工作前必读。规则按「踩过的坑」累积，**每踩一次加一条**。
> 总纲与完整方法论见知识库 [[复杂项目 Vibecoding 规则]]。

---

## 零、这个项目是什么

**Pane（窗格）** —— Windows 桌面悬浮管理条，把常用程序收成一条贴边窗格：一键开关、点击唤到前台、拖动排序、收进托盘。

| 项 | 值 |
| --- | --- |
| 技术栈 | Electron 45 · Node 22 · 原生 JS（无框架、无构建步骤） |
| 入口 | `src/main.js`（主进程，只做装配） |
| 模块 | `src/modules/`（8 个，见下表） |
| 界面 | `src/renderer/`（原生 DOM，无 React） |
| 数据 | exe 旁 `data/`（便携模式） |
| 目标平台 | Windows 10/11 x64 |

---

## 一、模块职责（改之前先看这里，别重复造轮子）

| 模块 | 职责 | 不要在这里做的事 |
| --- | --- | --- |
| `paths.js` | 全项目唯一路径来源；便携模式判定 | 别在别处拼路径 |
| `plugins.js` | 条目的增删改查与排序 | 别在 UI 里直接改数组 |
| `icons.js` | 图标提取（纯 JS 解析 .ico 与 PE 资源表） | **不要引入 Python/Pillow/外部图标库** |
| `launcher.js` | 程序启动、退出、运行状态检测 | 别在 main.js 里写 spawn |
| `winmgr.js` | Python 定位与 winmgr.py 调用 | 别硬编码 python 路径 |
| `settings.js` | 设置读写 | 别直接 fs 读写 settings.json |
| `logger.js` | 日志 | 别用 console.log 代替 |
| `proxy.js` | 代理探测 | — |
| `safefs.js` | **全项目唯一写文件入口**：原子写入、备份滚动、坏文件保留 | **不要直接 fs.writeFileSync 配置文件** |
| `updater.js` | 自动更新（GitHub Releases） | 失败必须吞掉，不能影响主程序 |
| `win32.js` | **原生窗口操作**：koffi 直调 Win32 枚举/聚焦/置顶/隐藏 | 不依赖 Python；失败返回 {ok:false} 不抛异常 |
| `winmgr.js` | 原生与 Python 的桥接层，**原生优先** | 新功能优先加进 win32.js |

**加新功能前先回答**：这件事 `src/modules/` 里有没有现成的？有就复用，没有才新建模块。

---

## 二、硬规矩

### 2.1 样式只认 DESIGN.md

- **所有颜色、间距、圆角、字号必须用 `src/renderer/style.css` 里 `:root` 的 CSS 变量**。
- 新增一个颜色之前，先看现有变量能不能表达。不能，再往 `:root` 里加，并在 `DESIGN.md` 登记。
- **禁止在 CSS 里写裸色值**（`#fff` 除外，它是纯白，可接受）。
- **禁止在 JS 里写界面颜色**。`PALETTE` 是图标兜底配色，属于数据不是样式，可以留。

### 2.1.1 原生依赖

- **koffi 是原生模块**，打包时必须 `asarUnpack: ["**/node_modules/koffi/**"]`，否则运行时找不到 .node 文件。
- 新增任何原生依赖都要同步 `build.asarUnpack`。
- **不要写 `build.electronDist`**。早期为了绕开下载问题硬编码成 `node_modules/electron/dist`，CI 上这个目录不存在会直接失败。electron-builder 自己会找。
- **`build.directories.output` 必须是相对路径**（写 `release`）。写成 `E:/...` 这种本机绝对路径，GitHub Actions 上会 `mkdir \\? ENOENT`。本地要输出到别处，用 `npm run dist:apps`。
- 窗口操作优先写在 `win32.js`，不要退回 Python —— 用户机器不一定装 Python。

### 2.2 窗口行为

- 窗口是**无边框 + 置顶 + 不进任务栏**的悬浮条，改窗口参数先看 `main.js` 顶部的常量区。
- 程序是**单实例**：重复启动必须唤到已有窗口，不能开第二个。
- 点 × 是**收进托盘**，不是退出。真正的退出在托盘菜单。

### 2.3 数据安全

- 用户数据只在 `data/` 下。**绝不写到程序目录之外**。
- 删除用户条目时**只改 `plugins.json`，不碰被管理程序的文件**。
- 不联网。任何外发请求都要先问过。

### 2.4 本机特有的坑（踩过，别再踩）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| `ELECTRON_RUN_AS_NODE=1` 被污染 | 双击 exe 静默退出，无报错 | 启动时清掉这个环境变量；调试前先 `Remove-Item Env:ELECTRON_RUN_AS_NODE` |
| 打包时 app 在运行 | `EPERM: unlink ...dll` | 打包前先 `Stop-Process -Name Pane` |
| 路径拼反斜杠 | PowerShell 里 `\"` 不是转义，路径被吞 | 路径用正斜杠或单引号 |
| electronDist 硬编码 | CI 报 `The specified electronDist does not exist` | 删掉 `build.electronDist`，让 builder 自动探测 |
| build 里写绝对路径 | CI 报 `mkdir \\? ENOENT` | output 用相对路径 `release` |
| koffi.proto 重复定义 | `Duplicate type name` | proto 定义提到模块级，只定义一次 |
| 中文路径进回收站 | Shell 接口偶发「系统调用级别不正确」 | 先改名再回收，或走 `知识库/40-产物/工具/回收站删除.ps1` |

---

## 三、提交前检查（每次都要过）

- [ ] `npm test` 通过（10 个单元测试，几秒）
- [ ] `npm run check` 语法检查通过
- [ ] 没有新增裸色值 / 裸像素（除已在 DESIGN.md 登记的）
- [ ] 没有新增重复逻辑（grep 一下已有模块）
- [ ] 没有留下注释掉的旧代码
- [ ] `AGENTS.md` 或 `DESIGN.md` 若需更新，已更新
- [ ] 打包验证：`npm run dist` 能出包，exe 能起

---

## 三之二、测试

| 命令 | 何时跑 | 耗时 |
| --- | --- | --- |
| `npm test` | 每次改完核心模块 | 几秒 |
| `npm run check` | 改动涉及主进程/渲染进程时 | 几秒 |
| `npm run dist` | 发版前 | 约 2 分钟 |

**不要每次提交都跑全量打包**。打包只在大功能完成或发版前跑。

新增核心逻辑时，同步在 `test/` 加用例——尤其是纯函数（路径拼接、数据转换、排序规则）。

---

## 四、发版

```bash
npm run dist      # 本地出包到 release/
git tag v1.x.x    # 推送后 GitHub Actions 自动编译并发布
git push origin v1.x.x
```

规则：**版本号只增不减**；发版前本地实测一遍 exe；保留上一版安装包。

---

## 五、这个文件怎么维护

- 被 Review 指出同一位置**两次**问题 → 加一条规则。
- 规则要**具体到可执行**，不写「注意代码质量」这种废话。
- 超过 3 个月没触发的规则，考虑删掉（避免规则库自己膨胀成负债）。