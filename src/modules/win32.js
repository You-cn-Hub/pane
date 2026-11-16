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
      GetWindowPlacement: user32.func("bool GetWindowPlacement(intptr_t hWnd, _Out_ uint8_t* wp)"),
      SetWindowPlacement: user32.func("bool SetWindowPlacement(intptr_t hWnd, const uint8_t* wp)"),
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

// pid -> exe 路径缓存。
// OpenProcess + QueryFullProcessImageNameW 是枚举里最贵的一步，
// 一次全量枚举 410 个窗口就要查 410 次。同一个 pid 在短时间内结果不会变，直接复用。
const exeCache = new Map();
const EXE_CACHE_TTL = 3000; // 3 秒

function exeOfPid(pid) {
  const now = Date.now();
  const hit = exeCache.get(pid);
  if (hit && now - hit.t < EXE_CACHE_TTL) return hit.v;

  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  let value = "";
  let h = 0n;
  try {
    h = fns.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  } catch {
    h = 0n;
  }
  if (h) {
    try {
      const buf = Buffer.alloc(1024 * 2);
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(1024, 0);
      if (fns.QueryFullProcessImageNameW(h, 0, buf, sizeBuf)) {
        const n = sizeBuf.readUInt32LE(0);
        value = buf.toString("utf16le", 0, n * 2);
      }
    } catch {
      value = "";
    } finally {
      try {
        fns.CloseHandle(h);
      } catch {}
    }
  }

  // 空结果也缓存：查不到的 pid 没必要每次都重试
  exeCache.set(pid, { v: value, t: now });
  // 缓存不能无限长，超过 500 条就清一次
  if (exeCache.size > 500) exeCache.clear();
  return value;
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
/**
 * 按条件找窗口。
 *
 * 性能要点：本机有 400+ 个窗口，但可见的只有十几个。
 * 每次全量枚举要给每个窗口查进程路径（OpenProcess），一次 16ms 左右。
 * 所以分两阶段：先只枚举可见窗口（0.6ms），找不到再扩大到全部。
 */
function findWindow({ process: procName, klass, title } = {}) {
  const wantProc = (procName || "").toLowerCase();
  const wantTitle = title ? new RegExp(title, "i") : null;

  const match = (list) =>
    list.filter((w) => {
      if (wantProc) {
        const base = (w.exe || "").split("\\").pop().toLowerCase();
        if (base !== wantProc && base !== wantProc + ".exe") return false;
      }
      if (klass && w.cls !== klass) return false;
      if (wantTitle && !wantTitle.test(w.title)) return false;
      return true;
    });

  const pick = (hits) => {
    if (!hits.length) return null;
    const score = (w) => {
      let s = 0;
      if (w.title) s += 100;
      if (w.visible) s += 10;
      if (/^(IME|MSCTFIME UI|Base_PowerMessageWindow|Electron_NotifyIconHostWindow|TaskbarWidgetThemeMonitor)/i.test(w.cls || "")) s -= 50;
      return s;
    };
    hits.sort((a, b) => score(b) - score(a));
    return hits[0];
  };

  // 第一阶段：只看可见窗口
  const quick = pick(match(listWindows(false)));
  if (quick && quick.title) return quick;

  // 第二阶段：可见窗口里没找到「有标题的」，再全量查一次
  const full = pick(match(listWindows(true)));
  return full || quick;
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

// ---------- 最小化 / 还原 ----------

const SW_SHOWNORMAL = 1;

/**
 * 读 WINDOWPLACEMENT 的 showCmd。
 * 结构：length(4) flags(4) showCmd(4) ptMin(8) ptMax(8) rcNormal(16) = 44 字节
 */
function showCmdOf(hWnd) {
  if (!load()) return -1;
  const buf = Buffer.alloc(44);
  buf.writeUInt32LE(44, 0);
  try {
    if (!fns.GetWindowPlacement(hWnd, buf)) return -1;
    return buf.readUInt32LE(8);
  } catch {
    return -1;
  }
}

/**
 * 最小化。
 *
 * 只用 ShowWindow(SW_MINIMIZE) 不可靠：它不改 WINDOWPLACEMENT，
 * 有些 Electron 窗口还会立刻弹回来。所以直接改 showCmd 再回写。
 */
function minimizeWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    const buf = Buffer.alloc(44);
    buf.writeUInt32LE(44, 0);
    if (!fns.GetWindowPlacement(hWnd, buf)) return { ok: false, error: "get_placement_failed" };

    // 最小化前把当前实际矩形写进 rcNormalPosition，
    // 这样以后无论走哪条还原路径，恢复的都是「用户最后用的尺寸」，
    // 而不是某个更早过期的大小。
    const r = rectOf(hWnd);
    if (r && r.w > 0 && r.h > 0) {
      buf.writeInt32LE(r.left, 28);
      buf.writeInt32LE(r.top, 32);
      buf.writeInt32LE(r.right, 36);
      buf.writeInt32LE(r.bottom, 40);
    }

    buf.writeUInt32LE(SW_SHOWMINIMIZED, 8);
    fns.SetWindowPlacement(hWnd, buf);
    // 兜底：有些程序不认 SetWindowPlacement，再补一次 ShowWindow
    const after = showCmdOf(hWnd);
    if (after !== SW_SHOWMINIMIZED) {
      fns.ShowWindow(hWnd, 6); // SW_MINIMIZE
    }
    return { ok: true, minimized: true, showCmd: showCmdOf(hWnd) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 从最小化还原。
 *
 * 关键：不能把 showCmd 硬写成 SW_SHOWNORMAL。
 * WINDOWPLACEMENT 里有两套信息：当前状态(showCmd) 和 正常位置矩形(rcNormalPosition)。
 * 直接 SetWindowPlacement(SW_SHOWNORMAL) 会让窗口按 rcNormalPosition 重新摆放，
 * 而那份矩形可能早就过期（用户后来拖动 / 改过大小），于是「第二次唤起尺寸变了」。
 *
 * 正确做法：优先只用 ShowWindow(SW_RESTORE)，让系统自己按最小化前的状态还原，
 * 不动位置和尺寸。只有 ShowWindow 无效时才退回 SetWindowPlacement，
 * 并且把 rcNormalPosition 换成当前实际矩形，避免用过期值。
 */
function restoreWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    // 先记住最小化前的实际矩形（GetWindowRect 在最小化时仍是最后一次正常位置）
    const before = rectOf(hWnd);

    fns.ShowWindow(hWnd, SW_RESTORE);

    // 检查是否真的还原了
    if (showCmdOf(hWnd) !== SW_SHOWMINIMIZED) {
      return { ok: true, restored: true };
    }

    // 兜底：ShowWindow 没生效，手动改 placement，但保留当前尺寸
    const buf = Buffer.alloc(44);
    buf.writeUInt32LE(44, 0);
    if (!fns.GetWindowPlacement(hWnd, buf)) {
      return { ok: false, error: "get_placement_failed" };
    }
    buf.writeUInt32LE(SW_SHOWNORMAL, 8);
    // 用最小化前记下的矩形覆盖 rcNormalPosition（偏移 28，4 个 int32）
    if (before) {
      buf.writeInt32LE(before.left, 28);
      buf.writeInt32LE(before.top, 32);
      buf.writeInt32LE(before.right, 36);
      buf.writeInt32LE(before.bottom, 40);
    }
    fns.SetWindowPlacement(hWnd, buf);
    fns.ShowWindow(hWnd, SW_RESTORE);
    return { ok: true, restored: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 窗口当前是不是「开着」的状态（可见且没最小化） */
function isOpen(hWnd) {
  if (!load()) return false;
  try {
    const visible = !!fns.IsWindowVisible(hWnd);
    const cmd = showCmdOf(hWnd);
    return visible && cmd !== SW_SHOWMINIMIZED;
  } catch {
    return false;
  }
}

/**
 * 这个程序的窗口群体里有没有托盘图标宿主窗口。
 *
 * 就是判断「这个软件本身有没有启用最小化到托盘」：
 *   Electron 应用在托盘放图标时，会创建一个 Electron_NotifyIconHostWindow；
 *   没有托盘图标的（比如 Obsidian 默认配置），就没有这个窗口。
 *
 * 用途：最小化时决定「真的最小化到任务栏」还是「收进托盘」。
 * 软件没提供托盘选项的话，硬藏起来用户就找不回来了。
 */
/**
 * 枚举系统里真实存在的进程名列表。
 *
 * 为什么不复用 listWindows：那个只反映「有窗口的进程」。
 * 程序收进托盘后窗口隐藏，listWindows 就查不到了，
 * 会被误判成「没在运行」——汽水音乐就是这个坑。
 *
 * 这里用 Toolhelp32 快照，直接读进程表，与窗口无关。
 */
function listProcessNames() {
  if (!load()) return [];
  const TH32CS_SNAPPROCESS = 0x00000002;
  try {
    const CreateToolhelp32Snapshot = kernel32.func("intptr_t CreateToolhelp32Snapshot(uint32 flags, uint32 pid)");
    const Process32FirstW = kernel32.func("bool Process32FirstW(intptr_t snap, _Inout_ uint8_t* pe)");
    const Process32NextW = kernel32.func("bool Process32NextW(intptr_t snap, _Inout_ uint8_t* pe)");

    const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snap || String(snap) === "-1") return [];

    // PROCESSENTRY32W 在 x64 上实际是 568 字节：
    //   dwSize(4) cntUsage(4) th32ProcessID(4) + 4 字节对齐填充
    //   th32DefaultHeapID(8) th32ModuleID(4) cntThreads(4)
    //   th32ParentProcessID(4) pcPriClassBase(4) dwFlags(4) + 4 字节对齐
    //   szExeFile[260] WCHAR(520)
    // 结构体大小给错，Process32FirstW 会直接返回 false。
    const SIZE = 568;
    const NAME_OFFSET = 44;
    const pe = Buffer.alloc(SIZE);
    pe.writeUInt32LE(SIZE, 0);

    const names = new Set();
    let ok = Process32FirstW(snap, pe);
    let guard = 0;
    while (ok && guard++ < 20000) {
      const nameBuf = pe.slice(NAME_OFFSET, NAME_OFFSET + 260 * 2);
      const s = nameBuf.toString("utf16le").replace(/\u0000.*$/, "");
      if (s) names.add(s);
      ok = Process32NextW(snap, pe);
    }
    try {
      fns.CloseHandle(snap);
    } catch {}
    return [...names];
  } catch {
    return [];
  }
}

/**
 * 优雅关闭：给主窗口发 WM_CLOSE，让程序自己走正常退出流程。
 *
 * 为什么重要：taskkill /F 是强制终止，程序来不及保存状态。
 * Obsidian / VS Code 这类会把窗口尺寸、布局写在退出时，
 * 直接强杀会导致下次启动「记不住上次的大小」。
 *
 * @returns {{ok:boolean, closed:number}} closed 是成功发出关闭消息的窗口数
 */
function closeByProcess(procName) {
  if (!load() || !procName) return { ok: false, closed: 0 };
  try {
    const want = String(procName).toLowerCase();
    const targets = listWindows(true).filter((x) => {
      const base = (x.exe || "").split("\\").pop().toLowerCase();
      if (base !== want && base !== want + ".exe") return false;
      // 只给有标题的主窗口发，辅助窗口发了没用
      if (!x.title) return false;
      // 托盘宿主 / IME 之类不要碰
      if (/^(IME|MSCTFIME UI|Electron_NotifyIconHostWindow|Base_PowerMessageWindow)/i.test(x.cls || "")) return false;
      return true;
    });
    let n = 0;
    for (const w of targets) {
      try {
        fns.PostMessageW(w.hWnd, WM_CLOSE, 0, 0);
        n++;
      } catch {}
    }
    return { ok: n > 0, closed: n };
  } catch {
    return { ok: false, closed: 0 };
  }
}

/** 某个进程名当前还有多少个实例在跑 */
function countProcess(procName) {
  if (!load() || !procName) return 0;
  try {
    const want = String(procName).toLowerCase();
    return listProcessNames().filter((n) => n.toLowerCase() === want || n.toLowerCase() === want + ".exe").length;
  } catch {
    return 0;
  }
}

function hasTrayIcon(procName) {
  if (!load() || !procName) return false;
  try {
    const want = String(procName).toLowerCase();
    return listWindows(true).some((w) => {
      const base = (w.exe || "").split("\\").pop().toLowerCase();
      if (base !== want && base !== want + ".exe") return false;
      return /NotifyIconHost|SystemTray|TrayWnd|TrayIcon/i.test(w.cls || "");
    });
  } catch {
    return false;
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
  minimizeWin,
  restoreWin,
  isOpen,
  hasTrayIcon,
  listProcessNames,
  closeByProcess,
  countProcess,
  showCmdOf,
};