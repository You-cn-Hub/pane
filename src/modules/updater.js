/**
 * 自动更新 —— 从 GitHub Releases 检查并下载新版本。
 *
 * 职责边界：
 *   - 只负责「检查 / 下载 / 提示重启」
 *   - 不在开发模式跑（app.isPackaged 为 false 时直接返回）
 *   - 所有失败都吞掉，更新挂了不能影响主程序运行
 *
 * 发布端约定见 package.json 的 build.publish（GitHub Releases）。
 */

const { app, dialog } = require("electron");

/**
 * @param {object} deps
 * @param {Function} deps.log  日志回调
 * @param {Function} deps.onStatus 状态变化回调（可选，供界面显示）
 */
function createUpdater(deps = {}) {
  const { log = () => {}, onStatus = () => {} } = deps;
  let updater = null;
  let state = { phase: "idle", version: null, message: "" };

  function setState(patch) {
    state = Object.assign({}, state, patch);
    try {
      onStatus(state);
    } catch {}
  }

  function init() {
    // 开发模式没有 publish 信息，跳过
    if (!app.isPackaged) {
      log("[update] 开发模式，跳过自动更新");
      setState({ phase: "disabled", message: "开发模式" });
      return null;
    }
    try {
      const { autoUpdater } = require("electron-updater");
      updater = autoUpdater;
    } catch (e) {
      log("[update] electron-updater 不可用:", e.message);
      setState({ phase: "error", message: e.message });
      return null;
    }

    // 不自动下载，先问用户
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;

    updater.on("checking-for-update", () => setState({ phase: "checking", message: "正在检查更新…" }));
    updater.on("update-available", (info) => {
      log("[update] 发现新版本", info.version);
      setState({ phase: "available", version: info.version, message: `发现新版本 ${info.version}` });
      // 静默下载，下完了再问要不要重启
      updater.downloadUpdate().catch((e) => log("[update] 下载失败:", e.message));
    });
    updater.on("update-not-available", () => setState({ phase: "latest", message: "已是最新版本" }));
    updater.on("download-progress", (p) => {
      setState({ phase: "downloading", message: `下载中 ${Math.round(p.percent || 0)}%` });
    });
    updater.on("update-downloaded", (info) => {
      log("[update] 下载完成", info.version);
      setState({ phase: "ready", version: info.version, message: "新版本已就绪" });
      dialog
        .showMessageBox({
          type: "info",
          title: "有新版本",
          message: `窗格 ${info.version} 已下载完成`,
          detail: "重启后生效。选「稍后」会在下次退出时自动安装。",
          buttons: ["立即重启", "稍后"],
          defaultId: 0,
          cancelId: 1,
        })
        .then((r) => {
          if (r.response === 0) {
            try {
              updater.quitAndInstall(false, true);
            } catch (e) {
              log("[update] 安装失败:", e.message);
            }
          }
        })
        .catch(() => {});
    });
    updater.on("error", (e) => {
      log("[update] 出错:", (e && e.message) || e);
      setState({ phase: "error", message: (e && e.message) || String(e) });
    });

    return updater;
  }

  /** 静默检查（启动后延迟调用） */
  async function checkSilent() {
    if (!updater) return { ok: false, error: "disabled" };
    try {
      await updater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      // 私有仓库取不到 release 是常见情况，不打扰用户
      log("[update] 检查失败:", e.message);
      setState({ phase: "error", message: e.message });
      return { ok: false, error: e.message };
    }
  }

  /** 手动检查（托盘菜单用），会弹结果 */
  async function checkManual() {
    if (!updater) {
      dialog.showMessageBox({
        type: "info",
        title: "检查更新",
        message: app.isPackaged ? "更新模块不可用" : "开发模式不支持自动更新",
        detail: app.isPackaged ? "请手动到 GitHub Releases 下载。" : "请使用 npm run dist 打包后测试。",
      });
      return { ok: false, error: "disabled" };
    }
    try {
      const r = await updater.checkForUpdates();
      if (!r || !r.updateInfo) return { ok: true, latest: true };
      return { ok: true };
    } catch (e) {
      dialog.showMessageBox({
        type: "warning",
        title: "检查更新失败",
        message: "没能连上更新服务器",
        detail: e.message + "\n\n可以到 GitHub Releases 页面手动下载。",
      });
      return { ok: false, error: e.message };
    }
  }

  return { init, checkSilent, checkManual, getState: () => state };
}

module.exports = { createUpdater };