/**
 * 启动 / 退出本地程序。
 *
 * 两种程序：
 *   - type "app"     普通 exe，按进程名找窗口来控制显示隐藏
 *   - type "webview" 背后是一个本地 HTTP 服务（工作台那种），
 *                     用端口探测它在不在，嵌入到面板里显示
 */

const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {Function} deps.runWinMgr    执行 winmgr 命令
 * @param {Function} deps.findArgs     按插件拼「找窗口」参数
 * @param {Function} deps.resolveExe   拿到条目的 exe 路径
 * @param {Function} deps.expandPath   展开配置里的路径占位符
 * @param {Function} deps.getPlugin    按 id 取条目
 */
function createLauncher(deps) {
  const { runWinMgr, findArgs, resolveExe, expandPath, getPlugin } = deps;

  /** 端口是否开着 */
  function portOpen(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.setTimeout(900, () => done(false));
    });
  }

  /**
   * 启动一个 exe 并脱离当前进程。
   *
   * 直接 spawn 有些 exe 会报 EACCES（权限特殊的程序就是这样），
   * 走 cmd 的 start（即 ShellExecute 路径）才稳。
   * 但 cmd start 会把参数再解析一遍，参数里有特殊字符就废了。
   * 所以：有参数时直接 spawn（参数原样传递），没参数时走 cmd start。
   */
  function launchDetached(exe, args, cwd) {
    const list = args || [];
    if (list.length) {
      try {
        spawn(exe, list, {
          detached: true,
          stdio: "ignore",
          cwd: cwd || path.dirname(exe),
        }).unref();
        return;
      } catch {
        // 落到下面的 cmd start 兜底
      }
    }
    const cmd = process.env.ComSpec || "cmd.exe";
    const params = ["/c", "start", "", exe, ...list];
    spawn(cmd, params, {
      detached: true,
      stdio: "ignore",
      cwd: cwd || path.dirname(exe),
    }).unref();
  }

  /**
   * 找到窗口；找不到就先把程序拉起来再等它出现。
   * @returns {Promise<{ok: boolean, title?: string, error?: string}>}
   */
  async function resolveWindow(p) {
    let r = await runWinMgr(findArgs(p));
    if (r.ok) return r;
    const exe = resolveExe(p);
    if (!exe) {
      return {
        ok: false,
        error: `找不到可执行文件：${(p.launch && (p.launch.path || p.launch.pathGlob)) || "(未配置)"}`,
      };
    }
    try {
      const L = p.launch || {};
      launchDetached(exe, (L.args || []).slice(), L.workdir || path.dirname(exe));
    } catch (e) {
      return { ok: false, error: `启动失败：${e.message}` };
    }
    // 启动慢的客户端可按插件配置延长等待
    const waitMs = (p.launch && p.launch.timeoutMs) || 20000;
    const steps = Math.max(1, Math.ceil(waitMs / 900));
    for (let i = 0; i < steps; i++) {
      await sleep(900);
      r = await runWinMgr(findArgs(p));
      if (r.ok) return r;
    }
    return { ok: false, error: `等了 ${Math.round(waitMs / 1000)} 秒窗口还没出现` };
  }

  /** 只启动，不切换面板 */
  async function launchOnly(id) {
    const p = getPlugin(id);
    if (!p) return { ok: false, error: "插件不存在" };

    // webview：拉起背后的本地服务，按端口探测就绪
    if (p.type === "webview") {
      const port = (p.probe && p.probe.port) || 8899;
      if (await portOpen(port)) return { ok: true, msg: `${p.name}服务已在运行` };
      const L = p.launch || {};
      if (!L.path) return { ok: false, error: "未配置启动命令" };
      try {
        spawn(expandPath(L.path), expandPath(L.args || []), {
          detached: true,
          stdio: "ignore",
          cwd: expandPath(L.cwd) || undefined,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "", HTTP_PROXY: "", HTTPS_PROXY: "" },
        }).unref();
      } catch (e) {
        return { ok: false, error: `启动失败：${e.message}` };
      }
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        if (await portOpen(port)) return { ok: true, msg: `${p.name}服务已启动` };
      }
      return { ok: false, error: "服务启动超时" };
    }

    const r = await runWinMgr(findArgs(p));
    if (r.ok) return { ok: true, msg: `${p.name} 已在运行` };
    const exe = resolveExe(p);
    if (!exe) return { ok: false, error: "找不到可执行文件" };
    try {
      const L = p.launch || {};
      launchDetached(exe, (L.args || []).slice(), L.workdir || path.dirname(exe));
      return { ok: true, msg: `正在启动 ${p.name}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 关闭某个客户端 */
  async function quitApp(id) {
    const p = getPlugin(id);
    if (!p) return { ok: false, error: "插件不存在" };

    if (p.type === "webview") {
      const port = (p.probe && p.probe.port) || 8899;
      if (!(await portOpen(port))) return { ok: true, msg: `${p.name}服务没在运行` };
      const kr = await runWinMgr(["killport", "--port", String(port)]);
      return { ok: kr.ok, msg: kr.ok ? `已停止${p.name}服务` : "停止失败" };
    }

    if (!p.find) return { ok: false, error: "该插件不可关闭" };

    const native = (() => {
      try {
        return require("./win32");
      } catch {
        return null;
      }
    })();
    const nativeOk = !!(native && native.isAvailable());

    /** 等进程真的从进程表消失；steps × 250ms */
    async function waitGone(steps) {
      if (!nativeOk) return false;
      for (let i = 0; i < steps; i++) {
        await sleep(250);
        if (native.countProcess(p.find.process) === 0) return true;
      }
      return false;
    }

    // 一、先优雅关闭：发 WM_CLOSE 让程序自己退出。
    // 直接强杀会来不及保存窗口尺寸和布局，下次启动就回到默认小窗口（Obsidian 就是这个问题）。
    // 最多等 6 秒。
    if (nativeOk) {
      const cr = native.closeByProcess(p.find.process);
      if (cr.ok && (await waitGone(24))) {
        return { ok: true, msg: `已关闭 ${p.name}` };
      }
    }

    // 二、优雅关闭没成功（程序无响应 / 只想收进托盘）→ 原生强杀。
    // 不走 Python：用户机器可能没装，杀不掉就会让界面卡在「关闭中」又弹回运行中。
    if (nativeOk && typeof native.killProcess === "function") {
      const kr = native.killProcess(p.find.process);
      if (kr.ok && (await waitGone(12))) {
        return { ok: true, msg: `已关闭 ${p.name}` };
      }
    }

    // 三、原生这条路走不通（例如没有原生模块），最后退回 winmgr
    const kr2 = await runWinMgr(["kill", "--hidden", "--process", p.find.process]);
    // 强杀是异步生效的：命令返回时进程往往还在收尾。
    // 一定要等它真的消失再返回，否则界面过一秒刷新时又读到「运行中」，胶囊就回弹成绿色。
    const gone = await waitGone(12);
    if (gone || kr2.ok) return { ok: true, msg: `已关闭 ${p.name}` };
    return { ok: false, msg: "关闭失败" };
  }

  return { portOpen, launchDetached, resolveWindow, launchOnly, quitApp };
}

module.exports = { createLauncher, sleep };
