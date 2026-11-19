/**
 * edgehide 单元测试 —— 几何是纯函数，状态机靠注入的假时间 / 假光标驱动。
 * 真实滑动效果靠真机人工验证，这里保证判定逻辑不出错。
 */
const assert = require("node:assert");
const {
  createEdgeHide,
  edgeOf,
  dockedPos,
  peekRect,
  inRect,
  EDGE,
  PEEK,
  IDLE_MS,
} = require("../src/modules/edgehide.js");

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  ✓", name);
    pass++;
  } catch (e) {
    console.log("  ✗", name, "\n     ", e.message);
    fail++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 屏幕：2560×1440，工作区与屏幕同大
const WA = { x: 0, y: 0, width: 2560, height: 1440 };
const R = (x, y, w = 214, h = 496) => ({ x, y, w, h });

/** 造一个假环境，之后只调 step() 就能推进状态 */
function mk(rect, cur) {
  const env = {
    rect,
    cur,
    t: 1000,
    panel: false,
    visible: true,
    moves: [],
  };
  const eh = createEdgeHide({
    getBounds: () => env.rect,
    getWorkArea: () => WA,
    move: (x, y) => {
      env.moves.push({ x, y });
      env.rect = Object.assign({}, env.rect, { x, y });
    },
    cursor: () => env.cur,
    now: () => env.t,
    isVisible: () => env.visible,
    isPanelOpen: () => env.panel,
  });
  return { eh, env };
}

(async () => {
  console.log("几何：贴哪条边");

  await test("贴右边", () => {
    assert.strictEqual(edgeOf(R(2346, 400), WA), "right");
  });

  await test("贴左边", () => {
    assert.strictEqual(edgeOf(R(0, 400), WA), "left");
  });

  await test("贴上边", () => {
    assert.strictEqual(edgeOf(R(1000, 0), WA), "top");
  });

  await test("贴下边", () => {
    assert.strictEqual(edgeOf(R(1000, 1440 - 496), WA), "bottom");
  });

  await test("离边缘远 → 不算贴边", () => {
    assert.strictEqual(edgeOf(R(1000, 400), WA), null);
  });

  await test("离边缘 16px 仍在阈值内", () => {
    assert.strictEqual(edgeOf(R(2560 - 214 - 16, 400), WA), "right");
  });

  await test("离边缘超过阈值 → null", () => {
    assert.strictEqual(edgeOf(R(2560 - 214 - EDGE - 5, 400), WA), null);
  });

  await test("已经伸出屏幕不算贴边（避免二次收起）", () => {
    assert.strictEqual(edgeOf(R(2400, 400), WA), null);
  });

  console.log("\n几何：收起后的位置与把手");

  await test("收右边：只露 PEEK 像素", () => {
    assert.deepStrictEqual(dockedPos("right", R(2346, 400), WA, PEEK), { x: 2560 - PEEK, y: 400 });
  });

  await test("收左边", () => {
    assert.deepStrictEqual(dockedPos("left", R(0, 400), WA, PEEK), { x: -214 + PEEK, y: 400 });
  });

  await test("收上边", () => {
    assert.deepStrictEqual(dockedPos("top", R(1000, 0), WA, PEEK), { x: 1000, y: -496 + PEEK });
  });

  await test("收下边", () => {
    assert.deepStrictEqual(dockedPos("bottom", R(1000, 944), WA, PEEK), { x: 1000, y: 1434 });
  });

  await test("把手贴在屏幕内那一条", () => {
    assert.deepStrictEqual(peekRect("right", R(2554, 400), WA, PEEK), { x: 2560 - PEEK, y: 400, w: PEEK, h: 496 });
    assert.deepStrictEqual(peekRect("top", R(1000, -490), WA, PEEK), { x: 1000, y: 0, w: 214, h: PEEK });
  });

  await test("inRect 含边界", () => {
    assert.strictEqual(inRect({ x: 0, y: 0 }, { x: 0, y: 0, w: 10, h: 10 }), true);
    assert.strictEqual(inRect({ x: 10, y: 10 }, { x: 0, y: 0, w: 10, h: 10 }), true);
    assert.strictEqual(inRect({ x: 11, y: 5 }, { x: 0, y: 0, w: 10, h: 10 }), false);
  });

  console.log("\n状态机：收起");

  await test("鼠标在窗外超过 IDLE_MS → 收起", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    eh.step(1000);
    assert.strictEqual(eh.isDocked(), false);
    env.t = 1000 + IDLE_MS + 100;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), true);
    await sleep(500); // 等滑动跑完（最长 320ms）
    assert.ok(env.moves.length > 0, "应该真的移动过窗口");
    assert.strictEqual(env.rect.x, 2560 - PEEK);
  });

  await test("鼠标在窗口里 → 不收", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 2400, y: 500 });
    eh.step(1000);
    env.t = 5000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), false);
  });

  await test("没贴边 → 不收", async () => {
    const { eh, env } = mk(R(1000, 400), { ok: true, x: 100, y: 100 });
    eh.step(1000);
    env.t = 5000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), false);
  });

  await test("面板展开 → 不收", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    env.panel = true;
    eh.step(1000);
    env.t = 5000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), false);
  });

  await test("窗口不可见 → 不收", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    env.visible = false;
    eh.step(1000);
    env.t = 5000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), false);
  });

  await test("刚被碰过 → 宽限期内不收", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    env.t = 1000;
    eh.touch();
    env.t = 1100; // 只过 100ms
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), false);
  });

  console.log("\n状态机：展开");

  await test("鼠标碰到把手 → 滑回原位", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    eh.step(1000);
    env.t = 3000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), true);
    await sleep(500);
    // 收在右边：把手是 x ∈ [2554,2560]
    env.cur = { ok: true, x: 2557, y: 600 };
    eh.step(env.t + 500);
    assert.strictEqual(eh.isDocked(), false);
    await sleep(500);
    assert.deepStrictEqual({ x: env.rect.x, y: env.rect.y }, { x: 2346, y: 400 });
  });

  await test("鼠标没碰到把手 → 保持收起", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    eh.step(1000);
    env.t = 3000;
    eh.step(env.t);
    await sleep(500);
    env.cur = { ok: true, x: 2500, y: 600 };
    eh.step(env.t + 500);
    assert.strictEqual(eh.isDocked(), true);
  });

  console.log("\n开关");

  await test("关掉时收起中的窗口会被放回来", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    eh.step(1000);
    env.t = 3000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), true);
    await sleep(500);
    eh.setEnabled(false);
    assert.strictEqual(eh.isDocked(), false);
    assert.strictEqual(eh.isEnabled(), false);
  });

  await test("关掉后不再自行收起", async () => {
    const { eh, env } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    eh.setEnabled(false);
    eh.step(1000);
    env.t = 5000;
    eh.step(env.t);
    assert.strictEqual(eh.isDocked(), false);
  });

  await test("isSettled 在静止时为 true", () => {
    const { eh } = mk(R(2346, 400), { ok: true, x: 1000, y: 700 });
    assert.strictEqual(eh.isSettled(), true);
  });

  console.log("\n回归：Electron getBounds 的形状（width/height）");

  await test("几何函数认 width/height", () => {
    const el = { x: 2346, y: 400, width: 214, height: 496 };
    assert.strictEqual(edgeOf(el, WA), "right");
    assert.deepStrictEqual(dockedPos("right", el, WA, PEEK), { x: 2560 - PEEK, y: 400 });
    assert.deepStrictEqual(peekRect("right", el, WA, PEEK), { x: 2560 - PEEK, y: 400, w: PEEK, h: 496 });
    assert.strictEqual(inRect({ x: 2400, y: 500 }, el), true);
  });

  await test("状态机用 width/height 形状也能收起 / 展开", async () => {
    let rect = { x: 2346, y: 400, width: 214, height: 496 };
    let cur = { ok: true, x: 1000, y: 700 };
    let t = 1000;
    const eh = createEdgeHide({
      getBounds: () => rect,
      getWorkArea: () => WA,
      move: (x, y) => {
        rect = Object.assign({}, rect, { x, y });
      },
      cursor: () => cur,
      now: () => t,
      isVisible: () => true,
    });
    eh.step(1000);
    t = 3000;
    eh.step(t);
    assert.strictEqual(eh.isDocked(), true);
    await sleep(500);
    cur = { ok: true, x: 2557, y: 600 };
    eh.step(3200);
    assert.strictEqual(eh.isDocked(), false);
  });

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail > 0 ? 1 : 0);
})();