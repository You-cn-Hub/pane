/**
 * 与 winmgr.py 的桥接 —— 负责定位 Python、执行窗口管理命令。
 *
 * 为什么需要 Python：
 *   Windows 上按进程名找窗口、读窗口位置、置顶这些操作，
 *   Node 没有直接 API，只能调 Win32。winmgr.py 用 ctypes 干这件事。
 *
 * 注意：图标提取**不**走这里（那是纯 JS 的），这里的 Python 只用于窗口管理。
 */

const { execFile } = require("child_process");
const path = require("path");
const net = require("net");

/**
 * @param {object} deps
 * @param {string} deps.winmgrPath  winmgr.py 的绝对路径
 * @param {string} deps.cwd         执行时的工作目录
 * @param {Function} deps.log       日志回调
 */
function createWinMgr(deps) {
  // 优先走原生实现（koffi 直调 Win32），不再依赖 Python。
  // 保留 Python 通道作为兜底：老机器上万一 koffi 加载失败，仍能工作。
  const native = require("./win32");

  /** 解析 ["action", "--flag", "val"] 这种数组形式 */
  function parseArgs(argv) {
    const out = { action: argv[0], _pos: [] };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (typeof a === "string" && a.startsWith("--")) {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
          out[key] = true;
        } else {
          out[key] = next;
          i++;
        }
      } else {
        out._pos.push(a);
      }
    }
    return out;
  }

  /**
   * 原生实现的分发。全部返回与 Python 版一致的结构（含 ok 字段）。
   * 遇到原生不支持的 action 返回 null，交由 Python 兜底。
   */
  function runNative(argv) {
    if (!native.isAvailable()) return null;
    const a = parseArgs(argv);
    const wantProc = a.process || a.name;
    const find = () =>
      native.findWindow({
        process: wantProc,
        klass: a.klass,
        title: a.title,
      });

    switch (a.action) {
      case "procs": {
        const list = native.listWindows(false);
        const names = [...new Set(list.map((w) => (w.exe || "").split("\\").pop()).filter(Boolean))];
        return { ok: true, procs: names };
      }
      case "fg": {
        const r = native.foreground();
        if (!r.ok) return r;
        return { ok: true, exe: (r.exe || "").split("\\").pop(), hwnd: r.hWnd ? String(r.hWnd) : null, title: r.title || "" };
      }
      case "find": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return { ok: true, found: true, hwnd: String(w.hWnd), title: w.title, rect: w.rect };
      }
      case "focus": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return Object.assign(native.focus(w.hWnd), { rect: w.rect });
      }
      case "show": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.showWin(w.hWnd);
      }
      case "state": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.stateOf(w.hWnd);
      }
      case "toggle": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        const st = native.stateOf(w.hWnd);
        if (!st.ok) return st;
        // 三态：没在前台 → 唤到前台；在前台但最小化 → 还原；在前台 → 沉底
        if (!st.foreground) {
          native.focus(w.hWnd);
          return { ok: true, action: "focus", focused: true };
        }
        if (st.minimized) {
          native.showWin(w.hWnd);
          return { ok: true, action: "restore", focused: true };
        }
        native.sendBottom(w.hWnd);
        return { ok: true, action: "bottom", focused: false };
      }
      case "bottom": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.sendBottom(w.hWnd);
      }
      case "noactivate": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.noActivate(w.hWnd);
      }
      case "activate": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.activateWin(w.hWnd);
      }
      case "hide": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.hideWin(w.hWnd);
      }
      case "close": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.closeWin(w.hWnd);
      }
      case "topmost": {
        const w = find();
        if (!w) return { ok: false, error: "not_found" };
        return native.setTopmost(w.hWnd, true);
      }
      case "kill": {
        // 关进程：taskkill 是系统自带的，不需要 Python
        const procName = a.process;
        if (!procName) return { ok: false, error: "missing_process" };
        return new Promise((resolve) => {
          execFile("taskkill", ["/IM", procName, "/F"], { windowsHide: true, timeout: 25000 }, (err, stdout, stderr) => {
            if (err) {
              // taskkill 的输出在中文系统上是 GBK，直接当 utf8 读会变乱码，
              // 所以不能靠文字匹配判断「进程不存在」，改用退出码 + 进程是否真的还在。
              const stillRunning = native
                ? native.listWindows(false).some((w) => (w.exe || "").split("\\").pop().toLowerCase() === String(procName).toLowerCase())
                : false;
              if (!stillRunning) {
                return resolve({ ok: true, killed: false, process: procName, detail: "进程未在运行" });
              }
              return resolve({ ok: false, error: "关闭失败，进程仍在运行", process: procName });
            }
            resolve({ ok: true, killed: true, process: procName, detail: String(stdout || "").trim().slice(0, 160) });
          });
        });
      }
      case "killport": {
        // 按端口找 PID 再杀。查连接用 netstat，杀用 taskkill
        const port = Number(a.port) || 0;
        if (!port) return { ok: false, error: "missing_port" };
        return new Promise((resolve) => {
          execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
            if (err) return resolve({ ok: false, error: "port_not_listening" });
            const line = String(stdout)
              .split(/\r?\n/)
              .find((l) => /LISTENING/i.test(l) && new RegExp(":" + port + "\\s").test(l));
            if (!line) return resolve({ ok: false, error: "port_not_listening" });
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (!pid || !/^\d+$/.test(pid)) return resolve({ ok: false, error: "pid_not_found" });
            execFile("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true, timeout: 15000 }, (e2) => {
              if (e2) return resolve({ ok: false, error: e2.message });
              resolve({ ok: true, pid: Number(pid), killed: true });
            });
          });
        });
      }
      case "lnk": {
        // 纯 JS 解析，不碰 COM —— 这台机器上 COM 实例化会被拦截，
        // PowerShell 方案本地能跑、目标机器上不一定能。
        const src = a.src;
        if (!src) return { ok: false, error: "missing_src" };
        try {
          return require("./lnk").parseLnk(src);
        } catch (e) {
          return { ok: false, error: "lnk_parse_failed: " + e.message };
        }
      }
      default:
        return null; // 交给 Python 兜底（assoc / verinfo / icon 等）
    }
  }
  const { winmgrPath: WINMGR, cwd: CWD, log = () => {} } = deps;

  // 打包后没有 node 的 __dirname 里那份解释器，得自己找
  const candidates = [];
  let pyExe = null;

  function initCandidates() {
    candidates.length = 0;
    candidates.push("python", "py");
    // 常见的每用户安装位置（Python 3.10 ~ 3.14）
    const local = process.env.LOCALAPPDATA || "";
    for (let v = 14; v >= 9; v--) {
      candidates.push(path.join(local, "Programs", "Python", `Python3${v}`, "python.exe"));
    }
    candidates.push("C:\\Python314\\python.exe", "C:\\Python313\\python.exe", "C:\\Python312\\python.exe");
  }

  async function resolvePython() {
    if (pyExe) return pyExe;
    initCandidates();
    for (const c of candidates) {
      const ok = await new Promise((resolve) => {
        try {
          execFile(c, ["-c", "print(1)"], { windowsHide: true, timeout: 6000 }, (err, out) => {
            resolve(!err && String(out).trim() === "1");
          });
        } catch {
          resolve(false);
        }
      });
      if (ok) {
        pyExe = c;
        log("[python] 使用", c);
        return c;
      }
    }
    log("[python] 没找到可用的 Python，窗口管理功能不可用");
    return null;
  }

  /**
   * 执行一条 winmgr 命令，返回解析后的 JSON。
   * 失败时返回 { ok: false, error }，永远不抛异常。
   */
  async function run(args, timeout = 9000, hide = true) {
    // 1) 先试原生：绝大多数窗口操作都在这里，不需要 Python
    try {
      const r = runNative(args);
      if (r) return r;
    } catch (e) {
      log("[win32] 原生调用失败，退回 Python:", e.message);
    }
    // 2) 原生不支持的动作（assoc / verinfo / lnk / icon / exeicon / kill / killport）走 Python
    const py = await resolvePython();
    if (!py) return { ok: false, error: "no_backend", message: "该操作需要 Python，且当前未安装" };
    return new Promise((resolve) => {
      execFile(
        py,
        [WINMGR, ...args],
        { windowsHide: hide, timeout, cwd: CWD },
        (err, stdout) => {
          if (err) return resolve({ ok: false, error: err.message });
          const line = String(stdout).trim().split("\n").pop();
          try {
            resolve(JSON.parse(line));
          } catch {
            resolve({ ok: false, error: "parse_failed", raw: line });
          }
        }
      );
    });
  }

  /** 按插件配置拼出「找窗口」的参数 */
  function findArgs(p) {
    const a = ["find", "--hidden", "--process", p.find.process];
    if (p.find.class) a.push("--class", p.find.class);
    if (p.find.title) a.push("--title", p.find.title);
    return a;
  }

  /**
   * 探测运行环境，供界面显示能力状态。
   * 返回 { ok, python, message }：ok=false 时界面应明确提示功能受限。
   */
  async function probe() {
    // 原生可用就不需要 Python 了
    if (native.isAvailable()) {
      return { ok: true, python: null, native: true, message: "" };
    }
    const py = await resolvePython();
    if (!py) {
      return {
        ok: false,
        python: null,
        message: "未检测到 Python。窗口切换、自动隐藏、置顶这些功能将不可用。",
        hint: "安装 Python 3（勾选 Add to PATH）后重启本程序即可恢复。",
      };
    }
    return { ok: true, python: py, message: "" };
  }

  return { run, findArgs, resolvePython, probe };
}

module.exports = { createWinMgr };
