# 窗格 · Pane

> 把常用的本地程序收进一条贴边窗格：一点开关、一点唤到前台、拖动排序、收进托盘。

![version](https://img.shields.io/badge/version-1.1.0-4ecdc4)
![platform](https://img.shields.io/badge/platform-Windows%20x64-0078d4)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 这是什么

桌面上常年开着一堆程序——聊天工具、笔记、代码编辑器、本地服务、脚本面板。它们散落在任务栏和桌面图标之间，每次切换都要找一遍。

**窗格**把这些程序收成一条窄窄的竖向条，贴在屏幕边缘：

| 能力 | 说明 |
| --- | --- |
| **一键开关** | 每个条目右侧的开关直接控制那个程序的启动与退出 |
| **点击唤到前台** | 不用在任务栏里翻，点图标就切过去 |
| **拖动排序** | 常用的排上面，顺序自己定 |
| **运行状态可见** | 哪条亮着就是它在跑，一眼看清谁在占资源 |
| **收进托盘** | 点 × 只是藏起来，程序继续跑 |

**不限于是 AI 工具**——它管理的是任意 Windows 程序：浏览器、IDE、游戏启动器、本地服务、批处理脚本都行。

---

## 特点

- **图标自动提取**：加一个 exe 就完事，不用手动找图标文件。纯 JS 实现（自己解析 `.ico` 与 PE 资源表），不依赖 Python，也不依赖 Pillow
- **便携运行**：数据存在 exe 旁边的 `data/`，整个文件夹拷走就能用
- **零运行时依赖**：窗口操作通过 koffi 直调 Win32，**不需要安装 Python 或任何运行时**
- **本地优先**：只访问 `127.0.0.1`，不联网、不上报任何数据
- **数据安全**：配置原子写入 + 自动备份，断电或强杀不会写坏
- **自动更新**：对接 GitHub Releases，有新版本会提示
- **单实例**：重复启动不会开出第二个，已有的会被唤到前台

---

## 安装

### 方式一：安装包（推荐）

从 [Releases](https://github.com/You-cn-Hub/pane/releases) 下载 `Pane-Setup-x.x.x.exe`，双击安装。

- 可选安装目录（默认 `%LOCALAPPDATA%\Programs\Pane`）
- 自动创建桌面与开始菜单快捷方式「窗格」
- 装完自动启动

### 方式二：绿色版

下载 `Pane-x.x.x-win-x64-portable.zip`，解压到任意位置，双击 `Pane.exe`。

数据会存在 exe 旁边的 `data/`，换电脑时连同文件夹一起拷走即可。

---

## 快速上手

1. 启动后，点右下角 **「+ 添加文件」**，选一个常用的 exe
2. 图标会自动抽出来，程序出现在列表里
3. 点右侧开关启动它；再点一次关闭
4. 拖动条目可调整顺序

---

## 开发

```bash
# 环境：Node.js 22+
npm install

# 开发模式（带 DevTools）
npm run dev

# 打包安装包 + 绿色版到 release/
npm run dist
```

### 目录结构

```
pane/
├── src/                  源码
│   ├── main.js           主进程入口（装配）
│   ├── modules/          按职责拆分，依赖注入
│   │   ├── paths.js      路径常量与便携模式
│   │   ├── plugins.js    条目增删改查与排序
│   │   ├── icons.js      图标提取（纯 JS）
│   │   ├── launcher.js   启动 / 退出程序
│   │   ├── winmgr.js     Python 定位与 winmgr.py 调用
│   │   ├── settings.js   设置读写
│   │   ├── logger.js     日志
│   │   └── proxy.js      代理探测
│   ├── renderer/         渲染进程 UI
│   └── preload*.js       预加载桥
├── assets/               图标资源
├── docs/                 文档
├── scripts/              构建与发布脚本
├── winmgr.py             窗口管理辅助
└── package.json
```

---

## 版本更新

发版流程：改 `package.json` 的 `version` → 打 tag → 推上去。GitHub Actions 会自动编译并上传到 Releases。

```bash
git tag v1.1.0
git push origin v1.1.0
```

---

## 许可

MIT