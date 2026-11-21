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
let shell32 = null;
let fns = null;
let available = false;
let enumProto = null;
let loadError = null;

// ---------- 常量 ----------
const SW_HIDE = 0;
const SW_SHOW = 5;
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
    try {
      shell32 = koffi.load("shell32.dll");
    } catch {
      shell32 = null;
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
      BringWindowToTop: user32.func("bool BringWindowToTop(intptr_t hWnd)"),
      SetFocus: user32.func("intptr_t SetFocus(intptr_t hWnd)"),
      AttachThreadInput: user32.func("bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)"),
      GetCurrentThreadId: kernel32.func("uint32 GetCurrentThreadId()"),
      GetCursorPos: user32.func("bool GetCursorPos(_Out_ int32_t* pt)"),
      SetCursorPos: user32.func("bool SetCursorPos(int x, int y)"),
      // 托盘图标靠真实鼠标事件点击：程序监听的是 shell 转发的鼠标消息，
      // 直接 SendMessage 到图标窗口没有统一的消息号
      mouse_event: user32.func("void mouse_event(uint32 flags, uint32 dx, uint32 dy, uint32 data, intptr_t extra)"),
      GetSystemMetrics: user32.func("int GetSystemMetrics(int n)"),
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
    // SwitchToThisWindow 是「抢前台」的最后一层兜底。
    // 它从 Win95 起就在 user32 里，但单独加载：万一哪天系统真没了这个符号，
    // 也只有兜底那一层失效，不至于整块原生能力都起不来。
    try {
      fns.SwitchToThisWindow = user32.func("void SwitchToThisWindow(intptr_t hWnd, bool fAltTab)");
    } catch {
      fns.SwitchToThisWindow = null;
    }

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

/**
 * 把窗口抢到前台。
 *
 * 裸 SetForegroundWindow 只在「调用进程本来就是前台」或「窗口属于当前输入队列」时才生效，
 * 否则 Windows 只让任务栏闪一下，什么都不发生。
 * Pane 自己是 WS_EX_NOACTIVATE（点击不激活窗口，这样点条目不会把悬浮条顶到前面），
 * 代价是点它的那一刻前台还停在别的程序上 —— 恰好踩中上面那条限制。
 * 所以「收着 → 还原并唤到前台」经常只见窗口还原、不见它来到前面。
 *
 * 按代价从低到高试三层，第一次成功就停：
 *   1. 直接设前台 —— Pane 碰巧是前台时的快路径
 *   2. 把本线程挂到前台线程与目标线程的输入队列上再设（AttachThreadInput）
 *   3. SwitchToThisWindow 兜底（未文档化的老 API，系统自己也还在用）
 *
 * 已经在前后不动输入焦点，免得打断用户正在打字的地方。
 * @returns {{ok:boolean, focused?:boolean, via?:string, error?:string}}
 *          focused=false 表示三层都没成功，窗口可能仍被压在下面。
 */
function focus(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  if (!hWnd) return { ok: false, error: "bad_hwnd" };
  try {
    if (fns.IsIconic(hWnd)) {
      // 最小化前是最大化的话，恢复也要按最大化来，否则会掉成普通尺寸
      const savedKey = String(hWnd);
      const savedCmd = hiddenShowCmd.get(savedKey);
      hiddenShowCmd.delete(savedKey);
      fns.ShowWindow(hWnd, savedCmd === SW_SHOWMAXIMIZED ? SW_SHOWMAXIMIZED : SW_RESTORE);
    } else if (!fns.IsWindowVisible(hWnd)) {
      // 被隐藏（不是最小化）的窗口：SW_SHOW 才能保住原尺寸和最大化状态
      hiddenShowCmd.delete(String(hWnd));
      fns.ShowWindow(hWnd, SW_SHOW);
    }

    if (fns.GetForegroundWindow() === hWnd) {
      fns.BringWindowToTop(hWnd);
      return { ok: true, focused: true, via: "already" };
    }

    if (fns.SetForegroundWindow(hWnd) && fns.GetForegroundWindow() === hWnd) {
      return { ok: true, focused: true, via: "direct" };
    }

    // 第二层：挂输入队列。前台窗口和目标窗口各挂一次——
    // 只挂前台线程在多数机器上就够，但有些程序（UWP、带输入法钩子的）
    // 要求目标线程自己在队列里，两层都试才稳。
    const fg = fns.GetForegroundWindow();
    const myTid = fns.GetCurrentThreadId();
    const fgTid = fg ? fns.GetWindowThreadProcessId(fg, Buffer.alloc(4)) : 0;
    const tgtTid = fns.GetWindowThreadProcessId(hWnd, Buffer.alloc(4));

    const attached = [];
    const attach = (tid) => {
      if (!tid || tid === myTid || attached.includes(tid)) return;
      try {
        if (fns.AttachThreadInput(myTid, tid, true)) attached.push(tid);
      } catch {}
    };
    attach(fgTid);
    attach(tgtTid);

    let ok = false;
    try {
      fns.BringWindowToTop(hWnd);
      ok = !!fns.SetForegroundWindow(hWnd);
      if (ok) {
        try {
          fns.SetFocus(hWnd);
        } catch {}
      }
    } catch {}

    // 一定要解挂：挂着输入队列会让本进程和对方共享输入状态，
    // 不解的话键盘焦点以后都可能是错的。顺序与挂上相反。
    for (const tid of attached.reverse()) {
      try {
        fns.AttachThreadInput(myTid, tid, false);
      } catch {}
    }

    if (ok && fns.GetForegroundWindow() === hWnd) {
      return { ok: true, focused: true, via: "attach" };
    }

    // 第三层：兜底
    try {
      if (fns.SwitchToThisWindow) fns.SwitchToThisWindow(hWnd, true);
    } catch {}
    const done = fns.GetForegroundWindow() === hWnd;
    return { ok: true, focused: done, via: done ? "switch" : "failed" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function showWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    hiddenShowCmd.delete(String(hWnd));
    // 隐藏中的窗口用 SW_SHOW：按原 placement 显示，最大化不会掉
    if (!fns.IsWindowVisible(hWnd)) {
      fns.ShowWindow(hWnd, SW_SHOW);
      return { ok: true, shown: true, via: "show" };
    }
    fns.ShowWindow(hWnd, SW_RESTORE);
    return { ok: true, shown: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function hideWin(hWnd) {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    // 先记下当前状态再隐藏：最大化窗口被 SW_HIDE 之后，
    // SW_RESTORE 恢复回来只有普通尺寸，用户会觉得「窗口变小了」
    const cmd = showCmdOf(hWnd);
    if (cmd === SW_SHOWNORMAL || cmd === SW_SHOWMAXIMIZED) {
      hiddenShowCmd.set(String(hWnd), cmd);
    }
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

/**
 * 鼠标指针的屏幕坐标。
 * 贴边收起要靠它判断「鼠标是不是在往把手那边去」——
 * 窗口收到收起之后界面收不到这个信息。
 */
function cursorPos() {
  if (!load()) return { ok: false, error: "no_native" };
  try {
    const buf = Buffer.alloc(8);
    if (!fns.GetCursorPos(buf)) return { ok: false, error: "get_cursor_failed" };
    return { ok: true, x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
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
const SW_SHOWMAXIMIZED = 3;

/**
 * 被 Pane 隐藏起来的窗口，隐藏前是普通还是最大化。
 *
 * 为什么必须记：Windows 上对一个**最大化**窗口调 ShowWindow(SW_HIDE)，
 * 之后 ShowWindow(SW_RESTORE) 恢复回来的是**普通尺寸**（最大化状态丢了）。
 * 用户看到的就是「收进托盘前是最大化，用 Pane 唤回来窗口变小了」。
 * key 用 String(hWnd)，比对 BigInt 稳定。
 */
const hiddenShowCmd = new Map();

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
    //
    // 但最大化时不能写：那时 GetWindowRect 给的是「最大化后的全屏矩形」，
    // 写进 rcNormalPosition 等于告诉系统「这窗口正常就这么大」，
    // 之后还原出来就是一个没最大化的巨型窗口。保留原本的记录。
    const curCmd = buf.readUInt32LE(8);
    const r = rectOf(hWnd);
    if (r && r.w > 0 && r.h > 0 && curCmd !== SW_SHOWMAXIMIZED) {
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
    const key = String(hWnd);
    hiddenShowCmd.delete(key);

    // 一、隐藏中的窗口：只能用 SW_SHOW，按窗口当前的 placement 显示。
    //    SW_RESTORE 会把它摊成 rcNormalPosition 里那个普通尺寸
    //    （实测：最大化 2576x1456 → 隐藏 → SW_RESTORE 变 1920x1059），
    //    Electron 应用还会因为尺寸突变内部布局跟不上，出现自绘标题栏消失、
    //    内容被裁掉一圈——用户看到的就是「窗口变小、标题栏没了」。
    //    这条路径主要来自程序自己点 ×  收进后台（Pane 没参与隐藏，拿不到记录）。
    if (!fns.IsWindowVisible(hWnd)) {
      fns.ShowWindow(hWnd, SW_SHOW);
      if (fns.IsWindowVisible(hWnd)) {
        return { ok: true, restored: true, via: "show" };
      }
    }

    // 二、最小化中的窗口：SW_RESTORE 是对的，它会还原到最小化前的状态
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

// ---------- 托盘图标 ----------

/**
 * 找某个程序的托盘图标位置。
 *
 * 用途：Electron 应用（DSH / 豆包这类）点 × 是自己把窗口 hide、进程留着。
 * Win32 强显（SW_SHOW）能让窗口框出现，但 Chromium 的 JS 层收不到通知，
 * 不重排布局、不画自绘标题栏——用户看到「窗口卡住、标题栏没了、内容被裁」。
 * 让程序自己显示的唯一可靠路径，就是点它自己的托盘图标。
 *
 * 定位用 Shell_NotifyIconGetRect：需要 hwnd + uID。
 * Electron 的托盘宿主 class 是 Electron_NotifyIconHostWindow，
 * uID 各程序不同，所以 0..15 挨个试，能拿到有效矩形的那次就是。
 *
 * @returns {{hWnd:bigint, uid:number, rect:{left,top,right,bottom}}|null}
 */
function trayIconRect(procName) {
  if (!load() || !shell32 || !procName) return null;
  try {
    if (!fns.ShellNotifyIconGetRect) {
      fns.ShellNotifyIconGetRect = shell32.func(
        "int Shell_NotifyIconGetRect(const void* id, _Out_ uint8_t* rect)"
      );
    }
    const want = String(procName).toLowerCase();
    const wantExe = want.endsWith(".exe") ? want : want + ".exe";
    const same = listWindows(true).filter((x) => {
      const base = (x.exe || "").split("\\").pop().toLowerCase();
      return base === want || base === wantExe;
    });
    const hosts = same.filter((x) => /NotifyIconHost/i.test(x.cls || ""));
    // 没有专门的宿主窗口就退到主窗口：有些程序把托盘挂在主窗口上
    const candidates = hosts.length ? hosts : same.filter((x) => x.title);
    for (const h of candidates) {
      for (let uid = 0; uid <= 15; uid++) {
        const id = Buffer.alloc(40);
        id.writeUInt32LE(40, 0);
        id.writeBigInt64LE(BigInt(h.hWnd), 8);
        id.writeUInt32LE(uid, 16);
        const rect = Buffer.alloc(16);
        if (fns.ShellNotifyIconGetRect(id, rect) !== 0) continue;
        const r = {
          left: rect.readInt32LE(0),
          top: rect.readInt32LE(4),
          right: rect.readInt32LE(8),
          bottom: rect.readInt32LE(12),
        };
        if (r.right - r.left < 4 || r.bottom - r.top < 4) continue;
        return { hWnd: h.hWnd, uid, rect: r };
      }
    }
  } catch {}
  return null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给托盘图标投一条消息，让程序自己把窗口打开 —— 不碰鼠标。
 *
 * 原理：点托盘图标时，explorer 并不会"模拟点击"，而是给图标所属的窗口
 * 发一条程序自己注册的回调消息。Electron 的托盘宿主窗口
 * （class = Electron_NotifyIconHostWindow）用的是 WM_APP + 1，
 * wParam 是图标 id，lParam 是鼠标消息。
 *
 * 实测（DSH）：SendMessage(host, WM_APP+1, 3, WM_LBUTTONDOWN) 就能把
 * 隐藏的窗口正常唤出来，尺寸和布局都保持原样。比移动光标安全得多：
 * 不抢用户的鼠标、不受任务栏自动隐藏影响。
 *
 * @returns {{ok:boolean, via?:string, error?:string}}
 */
function pokeTrayIcon(procName) {
  if (!load() || !procName) return { ok: false, error: "no_native" };
  const found = trayIconRect(procName);
  if (!found) return { ok: false, error: "no_tray_icon" };
  try {
    if (!fns.SendMessageTimeoutW) {
      fns.SendMessageTimeoutW = user32.func(
        "intptr_t SendMessageTimeoutW(intptr_t h, uint32 msg, intptr_t wp, intptr_t lp, uint32 flags, uint32 timeout, _Out_ intptr_t* result)"
      );
    }
    const WM_LBUTTONDOWN = 0x0201;
    const WM_LBUTTONUP = 0x0202;
    const WM_APP = 0x8000;
    const SMTO_ABORTIFHUNG = 0x0002;
    const hwnd = BigInt(found.hWnd);
    const uid = BigInt(found.uid);
    const res = Buffer.alloc(8);
    // 先按下再松开：有些实现只在 DOWN 里处理，有些等 UP 凑成一次完整点击
    fns.SendMessageTimeoutW(hwnd, WM_APP + 1, uid, BigInt(WM_LBUTTONDOWN), SMTO_ABORTIFHUNG, 800, res);
    fns.SendMessageTimeoutW(hwnd, WM_APP + 1, uid, BigInt(WM_LBUTTONUP), SMTO_ABORTIFHUNG, 800, res);
    return { ok: true, via: "message", uid: found.uid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 点一下这个程序的托盘图标，让程序自己把窗口显示出来。
 *
 * 任务栏自动隐藏时图标会被挤到屏幕外，这时先把光标压到屏幕底边把任务栏唤出来，
 * 再重新取位置。点完把光标放回原处，别让用户觉得鼠标被抢了。
 *
 * @returns {Promise<{ok:boolean, via?:string, error?:string}>}
 */
async function clickTrayIcon(procName) {
  if (!load() || !shell32) return { ok: false, error: "no_native" };
  let hit = trayIconRect(procName);
  if (!hit) return { ok: false, error: "no_tray_icon" };

  const sw = fns.GetSystemMetrics(0);
  const sh = fns.GetSystemMetrics(1);
  const onScreen = (r) =>
    r.left >= 0 && r.top >= 0 && r.right <= sw && r.bottom <= sh && r.top < sh - 1;

  // 原光标位置，点完还回去
  const cur = Buffer.alloc(8);
  let savedX = 0;
  let savedY = 0;
  let hasCursor = false;
  try {
    if (fns.GetCursorPos(cur)) {
      savedX = cur.readInt32LE(0);
      savedY = cur.readInt32LE(4);
      hasCursor = true;
    }
  } catch {}

  let via = "icon";
  if (!onScreen(hit.rect)) {
    // 任务栏是自动隐藏的：光标压到底边，等它浮出来再取一次
    try {
      fns.SetCursorPos(Math.round(sw / 2), sh - 1);
    } catch {}
    await sleepMs(700);
    hit = trayIconRect(procName);
    if (!hit || !onScreen(hit.rect)) {
      if (hasCursor) {
        try {
          fns.SetCursorPos(savedX, savedY);
        } catch {}
      }
      return { ok: false, error: "tray_hidden", rect: hit ? hit.rect : null };
    }
    via = "taskbar-float";
  }

  const cx = Math.round((hit.rect.left + hit.rect.right) / 2);
  const cy = Math.round((hit.rect.top + hit.rect.bottom) / 2);
  try {
    fns.SetCursorPos(cx, cy);
    await sleepMs(120);
    fns.mouse_event(0x0002, 0, 0, 0, 0n); // LEFTDOWN
    await sleepMs(60);
    fns.mouse_event(0x0004, 0, 0, 0, 0n); // LEFTUP
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (hasCursor) {
      setTimeout(() => {
        try {
          fns.SetCursorPos(savedX, savedY);
        } catch {}
      }, 200);
    }
  }
  return { ok: true, via, uid: hit.uid, rect: hit.rect };
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
  const names = new Set();
  for (const x of listProcessEntries()) names.add(x.name);
  return [...names];
}

/**
 * 进程表：pid + 进程名。
 *
 * 和 listProcessNames 读的是同一份 Toolhelp32 快照，区别是带出 pid ——
 * 强杀要按 pid 调 TerminateProcess，光有名字不够。
 *
 * @returns {Array<{pid:number, name:string}>}
 */
function listProcessEntries() {
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
    const PID_OFFSET = 8;
    const NAME_OFFSET = 44;
    const pe = Buffer.alloc(SIZE);
    pe.writeUInt32LE(SIZE, 0);

    const out = [];
    let ok = Process32FirstW(snap, pe);
    let guard = 0;
    while (ok && guard++ < 20000) {
      const pid = pe.readUInt32LE(PID_OFFSET);
      const name = pe
        .slice(NAME_OFFSET, NAME_OFFSET + 260 * 2)
        .toString("utf16le")
        .replace(/\u0000.*$/, "");
      if (pid && name) out.push({ pid, name });
      ok = Process32NextW(snap, pe);
    }
    try {
      fns.CloseHandle(snap);
    } catch {}
    return out;
  } catch {
    return [];
  }
}

/**
 * 强杀某个进程名的全部实例（TerminateProcess）。
 *
 * 为什么需要：优雅关闭发 WM_CLOSE，有些程序（Electron 类）只收进托盘不退出；
 * 这时只能强杀。以前强杀走 Python 的 winmgr.py，用户机器没装 Python 就杀不掉，
 * 界面上胶囊会一直卡在「关闭中」然后又亮回运行中。这里直调 Win32，不依赖 Python。
 *
 * @returns {{ok:boolean, killed:number}}
 */
function killProcess(procName) {
  if (!load() || !procName) return { ok: false, killed: 0 };
  const want = String(procName).toLowerCase();
  const wantExe = want.endsWith(".exe") ? want : want + ".exe";
  const targets = listProcessEntries().filter((x) => {
    const n = x.name.toLowerCase();
    return n === want || n === wantExe;
  });
  if (!targets.length) return { ok: false, killed: 0 };

  let TerminateProcess = null;
  try {
    TerminateProcess = kernel32.func("bool TerminateProcess(intptr_t h, uint32 code)");
  } catch {
    return { ok: false, killed: 0 };
  }

  const PROCESS_TERMINATE = 0x0001;
  let killed = 0;
  for (const t of targets) {
    let h = 0n;
    try {
      h = fns.OpenProcess(PROCESS_TERMINATE, false, t.pid);
    } catch {
      h = 0n;
    }
    if (!h) continue;
    try {
      if (TerminateProcess(h, 1)) killed++;
    } catch {}
    try {
      fns.CloseHandle(h);
    } catch {}
  }
  return { ok: killed > 0, killed };
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

// 键鼠空闲时长：静默安装新版本之前要确认用户真的不在用电脑
let idleFns = null;
function idleMs() {
  if (!load()) return 0;
  try {
    if (!idleFns) {
      idleFns = {
        GetLastInputInfo: user32.func("bool GetLastInputInfo(_Inout_ uint8_t* lii)"),
        GetTickCount: kernel32.func("uint32 GetTickCount()"),
      };
    }
    // LASTINPUTINFO { cbSize: DWORD, dwTime: DWORD }
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(8, 0);
    if (!idleFns.GetLastInputInfo(buf)) return 0;
    const last = buf.readUInt32LE(4);
    if (!last) return 0;
    const now = idleFns.GetTickCount() >>> 0;
    // 都是 32 位 tick，49 天回绕一次，用无符号相减
    return ((now - last) >>> 0) || 0;
  } catch {
    return 0;
  }
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
  cursorPos,
  stateOf,
  minimizeWin,
  restoreWin,
  isOpen,
  hasTrayIcon,
  listProcessNames,
  listProcessEntries,
  killProcess,
  closeByProcess,
  countProcess,
  trayIconRect,
  clickTrayIcon,
  pokeTrayIcon,
  showCmdOf,
  idleMs,
};