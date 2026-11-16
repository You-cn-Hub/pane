/**
 * win32 最小化 / 还原的集成测试。
 * 用记事本做真实窗口验证 —— 这是唯一能证明「最小化真的生效」的方式。
 */
const assert = require("node:assert");
const { spawn } = require("child_process");
const { createWinMgr } = require("../src/modules/winmgr.js");
const w = require("../src/modules/win32.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

(async () => {
  const wm = createWinMgr({ winmgrPath: "", cwd: __dirname, log: () => {} });

  console.log("最小化 / 还原完整循环");

  const proc = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
  proc.unref();
  await sleep(2500);

  const findMain = () => {
    const all = w.listWindows(true).filter((x) => /notepad/i.test(x.exe || ""));
    return all.find((x) => x.title) || all[0];
  };

  await test("记事本已启动且有窗口", async () => {
    const m = findMain();
    assert.ok(m, "找不到记事本窗口");
    assert.strictEqual(w.isOpen(m.hWnd), true);
  });

  await test("第一次 toggle 返回 minimize", async () => {
    const r = await wm.run(["toggle", "--hidden", "--process", "notepad.exe"]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, "minimize");
  });

  await test("最小化后 isOpen 为 false", async () => {
    await sleep(500);
    const m = findMain();
    assert.strictEqual(w.isOpen(m.hWnd), false);
  });

  await test("最小化后 showCmd 是 2", async () => {
    const m = findMain();
    assert.strictEqual(w.showCmdOf(m.hWnd), 2);
  });

  await test("第二次 toggle 返回 front（还原）", async () => {
    const r = await wm.run(["toggle", "--hidden", "--process", "notepad.exe"]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, "front");
  });

  await test("还原后 isOpen 为 true", async () => {
    await sleep(500);
    const m = findMain();
    assert.strictEqual(w.isOpen(m.hWnd), true);
  });

  await test("还原后 showCmd 是 1", async () => {
    const m = findMain();
    assert.strictEqual(w.showCmdOf(m.hWnd), 1);
  });

  await test("第三次 toggle 又是 minimize（可循环）", async () => {
    const r = await wm.run(["toggle", "--hidden", "--process", "notepad.exe"]);
    assert.strictEqual(r.action, "minimize");
  });

  // 清理
  await wm.run(["kill", "--process", "notepad.exe"]);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail > 0 ? 1 : 0);
})();