/**
 * 原生窗口管理 —— 用 koffi 直接调 Win32，替代原来的 Python (winmgr.py)。
 *
 * 为什么换掉 Python：
 *   Python 不是 Windows 自带的。别人装了本程序但没装 Python，
 *   窗口切换 / 自动隐藏 / 置顶就全部静默失效——这是"自己能用、别人不能用"的根源。
 *   koffi 是预编译的 FFI，随 npm 包分发，不需要用户装任何东西，也不需要编译工具链。
 *
 * 职责边界：
 *   - 只做窗口与进程的 Win32 调用
 *   - 图标提取不在这里（那是 icons.js 的纯 JS 实现）
 *   - 每个函数失败都返回 { ok:false, error }，不抛异常
 */

const koffi = require("koffi");

let user32 = null;
let kernel32 = null;
let psapi = null;
let fns = null;
let available = false;
let enumProto = null;
let loadError = null;

// ---------- 常量 ----------
const SW_HIDE = 0;
const SW_RESTORE = 9;
const SW_SHOWMINIMIZED = 2;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const HWND_TOP = 0;
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_EX_NOACTIVATE = 0x08000000;
const WM_CLOSE = 0x0010;

let tried = false;

function load() {
  if (fns) return fns;
  if (tried) return null;
  tried = true;
  if (process.platform !== "win32") {
    available = false;
    return null;
  }
  try {
    user32 = koffi.load("user32.dll");
    kernel32 = koffi.load("kernel32.dll");
    try {
      psapi = koffi.load("psapi.dll");
    } catch {
      psapi = koffi.load("kernel32.dll");
    }

    fns = {
      EnumWindows: user32.func("bool EnumWindows(void* cb, intptr_t lParam)"),
      IsWindow: user32.func("bool IsWindow(intptr_t hWnd)"),
      IsWindowVisible: user32.func("bool IsWindowVisible(intptr_t hWnd)"),
      GetWindowTextW: user32.func("int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t* buf, int n)"),
      GetClassNameW: user32.func("int GetClassNameW(intptr_t hWnd, _Out_ uint16_t* buf, int n)"),
      GetWindowThreadProcessId: user32.func("uint32 GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t* pid)"),
      ShowWindow: user32.func("bool ShowWindow(intptr_t hWnd, int nCmdShow)"),
      SetForegroundWindow: user32.func("bool SetForegroundWindow(intptr_t hWnd)"),
      GetForegroundWindow: user32.func("intptr_t GetForegroundWindow()"),
      SetWindowPos: user32.func("bool SetWindowPos(intptr_t hWnd, intptr_t hAfter, int x, int y, int cx, int cy, uint32 flags)"),
      GetWindowLongW: user32.func("int32 GetWindowLongW(intptr_t hWnd, int nIndex)"),
      SetWindowLongW: user32.func("int32 SetWindowLongW(intptr_t hWnd, int nIndex, int32 dwNewLong)"),
      PostMessageW: user32.func("bool PostMessageW(intptr_t hWnd, uint32 msg, intptr_t w, intptr_t l)"),
      IsIconic: user32.func("bool IsIconic(intptr_t hWnd)"),
      GetWindowRect: user32.func("bool GetWindowRect(intptr_t hWnd, _Out_ int32_t* rect)"),
      OpenProcess: kernel32.func("intptr_t OpenProcess(uint32 access, bool inherit, uint32 pid)"),
      CloseHandle: kernel32.func("bool CloseHandle(intptr_t h)"),
      QueryFullProcessImageNameW: kernel32.func("bool QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint16_t* buf, _Inout_ uint32* size)"),
    };
    available = true;
    return fns;
  } catch (e) {
    available = false;
    fns = null;
    // 把加载失败的原因暴露出去，否则打包后只能看到「原生不可用」却不知道为什么
    loadError = (e && (e.stack || e.message)) || String(e);
    return null;
  }
}

// ---------- 基础读取 ----------

function readWide(fn, hWnd, size = 512) {
  const buf = Buffer.alloc(size * 2);
  let n = 0;
  try {
    n = fn(hWnd, buf, size);
  } catch {
    return "";
  }
  if (!n || n <= 0) return "";
  return buf.toString("utf16le", 0, n * 2);
}

function pidOf(hWnd) {
  const buf = Buffer.alloc(4);
  try {
    fns.GetWindowThreadProcessId(hWnd, buf);
  } catch {
    return 0;
  }
  return buf.readUInt32LE(0);
}

function exeOfPid(pid) {
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  let h = 0n;
  try {
    h = fns.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  } catch {
    return "";
  }
  if (!h) return "";
  try {
    const buf = Buffer.alloc(1024 * 2);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(1024, 0);
    const ok = fns.QueryFullProcessImageNameW(h, 0, buf, sizeBuf);
    if (!ok) return "";
    const n = sizeBuf.readUInt32LE(0);
    return buf.toString("utf16le", 0, n * 2);
  } catch {
    return "";
  } finally {
    try {
      fns.CloseHandle(h);
    } catch {}
  }
}

function rectOf(hWnd) {
  const buf = Buffer.alloc(16);
  try {
    if (!fns.GetWindowRect(hWnd, buf)) return null;
  } catch {
    return null;
  }
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
    w: buf.readInt32LE(8) - buf.readInt32LE(0),
    h: buf.readInt32LE(12) - buf.readInt32LE(4),
  };
}

// ---------- 枚举 ----------

/**
 * 枚举所有顶层窗口。
 * @param {boolean} includeHidden 是否包含不可见窗口
 * @returns {Array<{hWnd:bigint, title:string, cls:string, pid:number, exe:string, visible:boolean, rect:object|null}>}
 */
function listWindows(includeHidden = false) {
  if (!load()) return [];
  const out = [];
  if (!enumProto) enumProto = koffi.proto("bool __stdcall EnumProc(intptr_t hWnd, intptr_t lParam)");
  const proto = enumProto;
  const cb = koffi.register((hWnd) => {
    try {
      const visible = fns.IsWindowVisible(hWnd);
      if (!visible && !includeHidden) return true;
      const title = readWide(fns.GetWindowTextW, hWnd);
      const cls = readWide(fns.GetClassNameW, hWnd, 256);
      // 无标题且不可见的一律跳过，减少噪音
      if (!title && !includeHidden) return true;
      const pid = pidOf(hWnd);
      out.push({
        hWnd,
        title,
        cls,
        pid,
        exe: exeOfPid(pid),
        visible,
        rect: rectOf(hWnd),
      });
    } catch {}
    return true;
  }, koffi.pointer(proto));
  try {
    fns.EnumWindows(cb, 0);
  } catch {}
  try {
    koffi.unregister(cb);
  } catch {}
  return out;
}

/** 按条件找窗口，多个命中取第一个可见且有标题的 */
function findWindow({ process: procName, klass, title } = {}) {
  const all = listWindows(true);
  const wantProc = (procName || "").toLowerCase();
  const wantTitle = title ? new RegExp(title, "i") : null;
  const hits = all.filter((w) => {
    if (wantProc) {
      const base = (w.exe || "").split("\\").pop().toLowerCase();
      if (base !== wantProc && base !== wantProc + ".exe") return false;
    }
    if (klass && w.cls !== klass) return false;
    if (wantTitle && !wantTitle.test(w.title)) return false;
    return true;
  });
  if (!hits.length) return null;

  // 排序规则（Electron 应用尤其重要）：
  //   1. 有标题的优先 —— 无标题的多是 Electron 的辅助窗口（widget host、IME、托盘），
  //      点它们唤不出主界面
  //   2. 同是有标题时，可见的优先
  //   3. 同分时优先非 IME / 非系统类
  const score = (w) => {
    let s = 0;
    if (w.title) s += 100;
    if (w.visible) s += 10;
    if (/^(IME|MSCTFIME UI|Base_PowerMessageWindow|Electron_NotifyIconHostWindow|TaskbarWidgetThemeMonitor)/i.test(w.cls || "")) s -= 50;
    return s;
  };
  hits.sort((a, b) => score(b) - score(a));
  return hits[0];
}

// ---------- 动作 ----------

function focus(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    if (fns.IsIconic(hWnd)) fns.ShowWindow(hWnd, SW_RESTORE);
    const ok = fns.SetForegroundWindow(hWnd);
    return { ok: true, focused: !!ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function showWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    fns.ShowWindow(hWnd, SW_RESTORE);
    return { ok: true, shown: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function hideWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    fns.ShowWindow(hWnd, SW_HIDE);
    return { ok: true, hidden: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function closeWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    fns.PostMessageW(hWnd, WM_CLOSE, 0, 0);
    return { ok: true, closed: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 沉到所有窗口之下但仍可见 */
function sendBottom(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    fns.SetWindowPos(hWnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    return { ok: true, bottom: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 加 WS_EX_NOACTIVATE：窗口永不抢焦点，点击直接穿透 */
function noActivate(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    const ex = fns.GetWindowLongW(hWnd, GWL_EXSTYLE);
    fns.SetWindowLongW(hWnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE);
    return { ok: true, noactivate: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 剥掉 WS_EX_NOACTIVATE 并抢焦点（录制快捷键时用） */
function activateWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    const ex = fns.GetWindowLongW(hWnd, GWL_EXSTYLE);
    fns.SetWindowLongW(hWnd, GWL_EXSTYLE, ex & ~WS_EX_NOACTIVATE);
    fns.SetForegroundWindow(hWnd);
    return { ok: true, activated: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 置顶 / 取消置顶 */
function setTopmost(hWnd, on) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    fns.SetWindowPos(hWnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    return { ok: true, topmost: !!on };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 移动 / 改变尺寸 */
function moveWin(hWnd, x, y, w, h) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    const flags = SWP_NOZORDER | SWP_NOACTIVATE;
    fns.SetWindowPos(hWnd, 0, x, y, w, h, flags);
    return { ok: true, rect: rectOf(hWnd) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 当前前台窗口的信息 */
function foreground() {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    const h = fns.GetForegroundWindow();
    if (!h) return { ok: true, hWnd: null, pid: 0, exe: "" };
    const pid = pidOf(h);
    return { ok: true, hWnd: h, pid, exe: exeOfPid(pid), title: readWide(fns.GetWindowTextW, h) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 窗口状态 */
function stateOf(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    return {
      ok: true,
      visible: !!fns.IsWindowVisible(hWnd),
      minimized: !!fns.IsIconic(hWnd),
      foreground: fns.GetForegroundWindow() === hWnd,
      rect: rectOf(hWnd),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isAvailable() {
  load();
  return !!fns;
}

module.exports = {
  isAvailable,
  getLoadError: () => loadError,
  listWindows,
  findWindow,
  focus,
  showWin,
  hideWin,
  closeWin,
  sendBottom,
  noActivate,
  activateWin,
  setTopmost,
  moveWin,
  foreground,
  stateOf,
};