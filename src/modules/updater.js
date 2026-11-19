/**
 * 自动更新 —— 两条通道，一条不行换另一条。
 *
 *   通道 A：electron-updater 直连 GitHub Releases。
 *           干净，但本机 github.com 是断的（timeout / ECONNRESET），实际用不上。
 *   通道 B：api.github.com 查最新 release（这台机器通），
 *           再按镜像前缀把安装包下下来（gh-proxy.com / ghproxy.cfd 等实测可用）。
 *
 * 行为：
 *   - 每 3 小时查一次，失败 30 分钟后重试
 *   - 下载静默进行，不打扰
 *   - 下完不立刻装：等到键鼠闲置 15 分钟才静默装（玩游戏、写东西时绝不会被打断）
 *
 * 所有失败都吞掉 —— 更新挂了不能影响主程序，这条比什么都重要。
 */

const { app, dialog } = require("electron");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { parseRelease, mirrorUrl, MIRRORS } = require("./updatefeed");

const OWNER = "You-cn-Hub";
const REPO = "pane";
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000; // 3 小时
const RETRY_AFTER_MS = 30 * 60 * 1000; // 失败后重试
const IDLE_INSTALL_MS = 15 * 60 * 1000; // 闲置多久才静默装
const API_TIMEOUT_MS = 8000;
const DL_TIMEOUT_MS = 60000;
const EU_TIMEOUT_MS = 12000;

/** 只取第一行：electron-updater 的报错常带一长串 URL，日志里留一行够定位了 */
function firstLine(s) {
  return String(s || "").split("\n")[0].slice(0, 240);
}

/** 取一个 URL 的正文，跟随重定向 */
function httpGetText(url, timeoutMs, redirects = 3) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "Pane-Updater", Accept: "application/vnd.github+json" } },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          const next = headers.location.startsWith("http")
            ? headers.location
            : new URL(headers.location, url).toString();
          resolve(httpGetText(next, timeoutMs, redirects - 1));
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          resolve({ ok: false, status: statusCode });
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ ok: true, body }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: "timeout" });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
  });
}

/** 把一个 URL 下到本地文件，带进度回调 */
function httpDownload(url, dest, onProgress, timeoutMs, redirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { "User-Agent": "Pane-Updater" } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        res.resume();
        const next = headers.location.startsWith("http")
          ? headers.location
          : new URL(headers.location, url).toString();
        resolve(httpDownload(next, dest, onProgress, timeoutMs, redirects - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        resolve({ ok: false, error: "HTTP " + statusCode });
        return;
      }
      const total = Number(headers["content-length"] || 0);
      let got = 0;
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      res.on("data", (chunk) => {
        got += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.min(99, Math.round((got / total) * 100)));
      });
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            fs.renameSync(tmp, dest);
            resolve({ ok: true, bytes: got });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      });
      out.on("error", (e) => resolve({ ok: false, error: e.message }));
      res.on("error", (e) => resolve({ ok: false, error: e.code || e.message }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

/**
 * @param {object} deps
 * @param {Function} deps.log
 * @param {Function} deps.onStatus
 * @param {string} deps.updateDir   下载目录（data/updates）
 * @param {Function} deps.idleMs    系统键鼠空闲毫秒
 * @param {Function} [deps.getAutoUpdate] 返回是否允许自动检查
 */
function createUpdater(deps = {}) {
  const { log = () => {}, onStatus = () => {}, updateDir = "", idleMs = () => 0, getAutoUpdate = () => true } = deps;
  let eu = null; // electron-updater（通道 A）
  let euReady = false;
  let state = { phase: "idle", version: null, message: "", channel: "" };
  let checkTimer = null;
  let idleTimer = null;
  let retryTimer = null;
  let pendingExe = null; // 通道 B 下好的安装包
  let busy = false;
  let lastEuError = ""; // 上一次 A 通道报错的原因，用来避免同一条打两遍

  function setState(patch) {
    state = Object.assign({}, state, patch);
    try {
      onStatus(state);
    } catch {}
  }

  // ---------- 通道 A：electron-updater ----------

  function initElectronUpdater() {
    if (!app.isPackaged) return false;
    try {
      const { autoUpdater } = require("electron-updater");
      eu = autoUpdater;
    } catch (e) {
      log("[update] electron-updater 不可用: " + e.message);
      return false;
    }
    eu.autoDownload = false;
    eu.autoInstallOnAppQuit = true;
    eu.on("update-available", (info) => {
      log("[update] A 通道发现新版本 " + info.version);
      setState({ phase: "available", version: info.version, message: "发现新版本 " + info.version, channel: "github" });
      eu.downloadUpdate().catch((e) => log("[update] A 通道下载失败: " + e.message));
    });
    eu.on("download-progress", (p) => {
      setState({ phase: "downloading", message: "下载中 " + Math.round(p.percent || 0) + "%", channel: "github" });
    });
    eu.on("update-downloaded", (info) => {
      log("[update] A 通道下载完成 " + info.version);
      setState({ phase: "ready", version: info.version, message: "新版本已就绪，闲置后自动安装", channel: "github" });
    });
    eu.on("error", (e) => {
      lastEuError = (e && e.message) || String(e);
      log("[update] A 通道出错: " + firstLine(lastEuError));
    });
    euReady = true;
    return true;
  }

  /** 通道 A 检查，带超时；成功返回 true */
  async function tryChannelA() {
    if (!euReady) return false;
    lastEuError = "";
    try {
      const r = await Promise.race([
        eu.checkForUpdates(),
        new Promise((res) => setTimeout(() => res(null), EU_TIMEOUT_MS)),
      ]);
      if (!r) {
        log("[update] A 通道超时，走镜像通道");
        return false;
      }
      return true;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // error 事件已经记过同样的原因，这里不重复刷屏
      if (msg !== lastEuError) log("[update] A 通道失败: " + firstLine(msg) + "，走镜像通道");
      return false;
    }
  }

  // ---------- 通道 B：API + 镜像 ----------

  async function tryChannelB() {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
    const r = await httpGetText(url, API_TIMEOUT_MS);
    if (!r.ok) {
      log("[update] B 通道查不到 release: " + (r.error || r.status));
      setState({ phase: "error", message: r.error || "HTTP " + r.status });
      return false;
    }
    let release;
    try {
      release = JSON.parse(r.body);
    } catch (e) {
      log("[update] B 通道返回不是 JSON");
      return false;
    }
    const parsed = parseRelease(release, app.getVersion());
    if (!parsed.version) {
      log("[update] B 通道没解析出版本号");
      return false;
    }
    if (!parsed.hasUpdate) {
      log("[update] B 通道：已是最新（当前 " + app.getVersion() + "，远端 " + parsed.version + "）");
      setState({ phase: "latest", version: parsed.version, message: "已是最新版本" });
      return true;
    }

    setState({
      phase: "available",
      version: parsed.version,
      message: "发现新版本 " + parsed.version,
      channel: "mirror",
    });
    return await download(parsed);
  }

  async function download(parsed) {
    if (!updateDir) return false;
    try {
      fs.mkdirSync(updateDir, { recursive: true });
    } catch (e) {
      log("[update] 建下载目录失败: " + e.message);
      return false;
    }
    const dest = path.join(updateDir, parsed.asset.name);
    // 已经下过就直接用
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
        pendingExe = dest;
        setState({ phase: "ready", version: parsed.version, message: "新版本已就绪，闲置后自动安装", channel: "mirror" });
        return true;
      }
    } catch {}

    for (const mirror of MIRRORS) {
      const url = mirrorUrl(mirror, parsed.asset.browser_download_url);
      const label = mirror ? mirror.replace(/^https?:\/\//, "").replace(/\/$/, "") : "GitHub 直连";
      log("[update] 尝试从 " + label + " 下载");
      const onProgress = (pct) =>
        setState({ phase: "downloading", message: "下载中 " + pct + "%", channel: mirror ? "mirror" : "github" });
      const r = await httpDownload(url, dest, onProgress, DL_TIMEOUT_MS);
      if (r.ok) {
        log("[update] 下载完成 " + label + " " + Math.round(r.bytes / 1048576) + " MB");
        pendingExe = dest;
        setState({ phase: "ready", version: parsed.version, message: "新版本已就绪，闲置后自动安装", channel: mirror ? "mirror" : "github" });
        return true;
      }
      log("[update] " + label + " 失败: " + r.error);
    }

    // 全都不行就退回「给个下载页」这条路，至少不让人卡死
    setState({ phase: "error", message: "所有下载通道都失败" });
    return false;
  }

  // ---------- 调度 ----------

  /** 检查一次；manual=true 时失败会弹框 */
  async function check(manual) {
    if (busy) return { ok: false, error: "busy" };
    if (!app.isPackaged && !manual) return { ok: false, error: "dev" };
    busy = true;
    try {
      setState({ phase: "checking", message: "正在检查更新…" });
      const a = await tryChannelA();
      if (a) return { ok: true };
      const b = await tryChannelB();
      if (!b && manual) {
        dialog.showMessageBox({
          type: "warning",
          title: "检查更新失败",
          message: "没能连上更新服务器",
          detail: "GitHub 和镜像都不通。可以到 Releases 页面手动下载。",
        });
      }
      return { ok: b };
    } catch (e) {
      log("[update] 检查异常: " + ((e && e.message) || e));
      return { ok: false, error: e.message };
    } finally {
      busy = false;
      scheduleNext(state.phase === "error");
    }
  }

  function scheduleNext(failed) {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = null;
      if (!getAutoUpdate()) {
        scheduleNext(false);
        return;
      }
      check(false);
    }, failed ? RETRY_AFTER_MS : CHECK_EVERY_MS);
    if (checkTimer.unref) checkTimer.unref();
  }

  /** 闲置够了就把新版本装上；有键鼠输入就一直等 */
  function watchIdle() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (state.phase !== "ready") return;
      let idle = 0;
      try {
        idle = idleMs() || 0;
      } catch {}
      if (idle < IDLE_INSTALL_MS) return;
      log("[update] 闲置 " + Math.round(idle / 60000) + " 分钟，开始静默安装");
      installNow(true);
    }, 60000);
    if (idleTimer.unref) idleTimer.unref();
  }

  /** silent=true 时不弹确认，直接装 */
  function installNow(silent) {
    if (pendingExe) {
      // 通道 B：自己下好的安装包，直接跑；NSIS 会自己接管替换
      try {
        require("child_process").spawn(pendingExe, [], { detached: true, stdio: "ignore" }).unref();
        log("[update] 已启动安装包，退出主程序");
        setTimeout(() => {
          app.quit();
        }, 800);
        return { ok: true };
      } catch (e) {
        log("[update] 启动安装包失败: " + e.message);
      }
    }
    if (euReady) {
      try {
        eu.quitAndInstall(silent, true);
        return { ok: true };
      } catch (e) {
        log("[update] 安装失败: " + e.message);
      }
    }
    return { ok: false, error: "没有可安装的更新" };
  }

  // ---------- 对外 ----------

  function init() {
    if (!app.isPackaged) {
      setState({ phase: "disabled", message: "开发模式" });
      log("[update] 开发模式，跳过自动更新");
      return null;
    }
    initElectronUpdater();
    watchIdle();
    log("[update] 初始化完成，通道 A " + (euReady ? "可用" : "不可用") + "，镜像候选 " + (MIRRORS.length - 1) + " 个");
    return eu;
  }

  /** 启动后延迟调的静默检查 */
  async function checkSilent() {
    if (!getAutoUpdate()) return { ok: false, error: "disabled" };
    return check(false);
  }

  /** 手动检查：结果直接弹框 */
  async function checkManual() {
    if (!app.isPackaged) {
      dialog.showMessageBox({
        type: "info",
        title: "检查更新",
        message: "开发模式不支持自动更新",
        detail: "请使用 npm run dist 打包后测试。",
      });
      return { ok: false, error: "dev" };
    }
    const r = await check(true);
    if (r.ok && state.phase === "latest") {
      dialog.showMessageBox({
        type: "info",
        title: "检查更新",
        message: "已是最新版本",
        detail: "当前版本 " + app.getVersion(),
      });
    }
    return r;
  }

  return { init, checkSilent, checkManual, installNow, getState: () => state };
}

module.exports = { createUpdater };
