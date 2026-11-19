/**
 * 贴边自动收起 —— 窗格贴住屏幕某条边后，鼠标离开一会儿就滑出屏幕，
 * 只在边上留一条 6px 的把手；鼠标碰到把手，它滑回原位。
 *
 * 为什么在主进程轮询光标，而不是靠界面上的 mouseenter / mouseleave：
 *   收起后窗口大部分在屏幕外，界面根本收不到「鼠标正在接近」这件事。
 *   GetCursorPos 是 0.1ms 级的调用，150ms 一次的开销可以忽略。
 *
 * 几何部分（edgeOf / dockedPos / peekRect / inRect）全是纯函数，可以脱窗单测。
 * 状态机（step）依赖都是注入的，测试里可以喂假时间、假光标。
 *
 * 与既有行为的边界：
 *   - 面板展开时不收起（isPanelOpen）
 *   - 窗口不可见时不收起（isVisible）
 *   - 拖动、热键、托盘换出时都算「刚被碰过」，宽限 400ms 内不收起
 */

const EDGE = 24;        // 距边缘多少像素算「贴边」
const PEEK = 6;         // 收起后露在屏幕内的把手宽度
const IDLE_MS = 1200;   // 鼠标离开多久后收起
const TOUCH_GRACE = 400; // 刚被动过之后的不收期
const TICK_MS = 150;
const TOL = 2;          // 判定把手时的容差，屏幕边缘的像素取整会差一两个
// 滑动动画：按距离定时长，帧间隔 8ms。
// 早先用固定 8 帧 / 12ms，一帧要跳 50 多像素，肉眼就是几下硬位移。
const FRAME_MS = 8;
const MIN_MS = 160;
const MAX_MS = 320;
const MS_PER_PX = 1.2;

/**
 * 统一矩形的宽高字段名。
 *
 * Electron 的 win.getBounds() 返回 {x, y, width, height}，
 * 而这里算边缘用短名 w / h。两种都得认 ——
 * 只认一种的时候，判边会算出 NaN，窗口贴到边上也不会有任何反应。
 */
function normRect(r) {
  if (!r) return null;
  const w = r.w != null ? r.w : r.width;
  const h = r.h != null ? r.h : r.height;
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { x: r.x, y: r.y, w, h };
}

/** 点是否落在矩形内（tol 为向外扩的容差） */
function inRect(p, r, tol = 0) {
  const b = normRect(r);
  if (!p || !b) return false;
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

/** 窗口贴住的是哪条边；没贴返回 null。已经伸出屏幕外的也算没贴（避免二次收起） */
function edgeOf(rect, wa, threshold = EDGE) {
  const b = normRect(rect);
  if (!b || !wa) return null;
  const gaps = {
    left: b.x - wa.x,
    top: b.y - wa.y,
    right: wa.x + wa.width - (b.x + b.w),
    bottom: wa.y + wa.height - (b.y + b.h),
  };
  let side = null;
  let min = Infinity;
  for (const k of Object.keys(gaps)) {
    const v = gaps[k];
    if (v < min) {
      min = v;
      side = k;
    }
  }
  if (min < 0) return null;
  return min <= threshold ? side : null;
}

/** 收起后窗口应该在的位置 */
function dockedPos(side, rect, wa, peek = PEEK) {
  const b = normRect(rect);
  if (!b || !wa) return { x: 0, y: 0 };
  switch (side) {
    case "right":
      return { x: wa.x + wa.width - peek, y: b.y };
    case "left":
      return { x: wa.x - b.w + peek, y: b.y };
    case "top":
      return { x: b.x, y: wa.y - b.h + peek };
    case "bottom":
      return { x: b.x, y: wa.y + wa.height - peek };
    default:
      return { x: b.x, y: b.y };
  }
}

/** 收起后留在屏幕内的那条把手 */
function peekRect(side, rect, wa, peek = PEEK) {
  const b = normRect(rect);
  if (!b || !wa) return { x: 0, y: 0, w: 0, h: 0 };
  switch (side) {
    case "right":
      return { x: wa.x + wa.width - peek, y: b.y, w: peek, h: b.h };
    case "left":
      return { x: wa.x, y: b.y, w: peek, h: b.h };
    case "top":
      return { x: b.x, y: wa.y, w: b.w, h: peek };
    case "bottom":
      return { x: b.x, y: wa.y + wa.height - peek, w: b.w, h: peek };
    default:
      return { x: b.x, y: b.y, w: 0, h: 0 };
  }
}

/**
 * @param {object} deps
 * @param {Function} deps.getBounds     () => {x,y,w,h} | null
 * @param {Function} deps.getWorkArea   (x,y) => {x,y,width,height} | null
 * @param {Function} deps.move          (x,y) => void  真正移动窗口
 * @param {Function} deps.cursor        () => {ok, x, y}
 * @param {Function} [deps.now]         时间源，测试可注入
 * @param {Function} [deps.log]
 * @param {Function} [deps.isPanelOpen]
 * @param {Function} [deps.isVisible]
 * @param {Function} [deps.onDock]      (docked:boolean) => void
 */
function createEdgeHide(deps = {}) {
  const {
    getBounds,
    getWorkArea,
    move,
    cursor,
    now = () => Date.now(),
    log = () => {},
    isPanelOpen = () => false,
    isVisible = () => true,
    onDock = () => {},
  } = deps;

  let enabled = true;
  let docked = false;
  let side = null;
  let savedPos = null;    // 收起前的正常位置，展开时回到这里
  let animating = false;
  let idleAt = -1;
  let lastTouch = 0;
  let timer = null;

  function slide(fromX, fromY, toX, toY, done) {
    const dist = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY));
    const duration = Math.max(MIN_MS, Math.min(MAX_MS, dist * MS_PER_PX));
    const beganAt = Date.now();
    animating = true;

    const frame = () => {
      // 按真实经过的时间算进度，而不是按帧数 ——
      // Windows 的定时器粒度约 15ms，数帧会让快慢跟着机器变。
      const k = Math.min(1, (Date.now() - beganAt) / duration);
      // easeOutCubic：起步快、收尾缓，看起来像被推出去然后停住
      const e = 1 - Math.pow(1 - k, 3);
      const x = Math.round(fromX + (toX - fromX) * e);
      const y = Math.round(fromY + (toY - fromY) * e);
      try {
        move(x, y);
      } catch {}
      if (k >= 1) {
        animating = false;
        if (done) done();
        return;
      }
      const t = setTimeout(frame, FRAME_MS);
      // 测试环境里别让这几帧拖住进程退出
      if (t && t.unref) t.unref();
    };
    frame();
  }

  function dock(toSide, rect, wa) {
    side = toSide;
    savedPos = { x: rect.x, y: rect.y };
    docked = true;
    idleAt = -1;
    const t = dockedPos(toSide, rect, wa, PEEK);
    log(`[edge] 收起 ${toSide} ${rect.x},${rect.y} → ${t.x},${t.y}`);
    onDock(true);
    slide(rect.x, rect.y, t.x, t.y);
  }

  function undock(reason = "") {
    if (!docked) return false;
    const from = getBounds();
    docked = false;
    side = null;
    idleAt = -1;
    log(`[edge] 展开${reason ? " (" + reason + ")" : ""} ${from ? from.x + "," + from.y : "?"} → ${savedPos ? savedPos.x + "," + savedPos.y : "?"}`);
    onDock(false);
    if (!from || !savedPos) return true;
    slide(from.x, from.y, savedPos.x, savedPos.y);
    return true;
  }

  /** 跑一次判定。start() 里按 TICK_MS 调；测试里直接调。 */
  function step(ts = now()) {
    if (!enabled || animating) return;
    const rect = getBounds();
    if (!rect) return;
    const wa = getWorkArea(rect.x, rect.y);
    if (!wa) return;

    if (docked) {
      if (!isVisible()) return;
      const c = cursor();
      if (c && c.ok && inRect(c, peekRect(side, rect, wa, PEEK), TOL)) undock("碰到把手");
      return;
    }

    if (!isVisible() || isPanelOpen()) {
      idleAt = -1;
      return;
    }

    const c = cursor();
    if (!c || !c.ok) return;

    // 鼠标还在窗格里 —— 用户在用它，别收
    if (inRect(c, rect, TOL)) {
      idleAt = -1;
      return;
    }
    // 刚拖过 / 刚唤出：给一点宽限，别让窗口在手上消失
    if (ts - lastTouch < TOUCH_GRACE) {
      idleAt = -1;
      return;
    }

    const s = edgeOf(rect, wa, EDGE);
    if (!s) {
      idleAt = -1;
      return;
    }

    if (idleAt < 0) {
      idleAt = ts;
      return;
    }
    if (ts - idleAt >= IDLE_MS) dock(s, rect, wa);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        step();
      } catch {}
    }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function setEnabled(on) {
    enabled = !!on;
    idleAt = -1;
    if (!enabled && docked) undock("关闭了贴边收起");
  }

  return {
    start,
    stop,
    step,
    setEnabled,
    touch: () => {
      lastTouch = now();
    },
    undock,
    isDocked: () => docked,
    isSettled: () => !docked && !animating,
    isEnabled: () => enabled,
    side: () => side,
  };
}

module.exports = {
  createEdgeHide,
  edgeOf,
  dockedPos,
  peekRect,
  inRect,
  normRect,
  EDGE,
  PEEK,
  IDLE_MS,
};