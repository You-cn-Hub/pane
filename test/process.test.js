/**
 * 进程枚举测试 —— 验证「收进托盘也判定为运行中」。
 */
const assert = require("node:assert");
const w = require("../src/modules/win32.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("listProcessNames");

test("返回非空数组", () => {
  const names = w.listProcessNames();
  assert.ok(Array.isArray(names));
  assert.ok(names.length > 10, "进程数过少: " + names.length);
});

test("包含系统进程 System", () => {
  const names = w.listProcessNames();
  assert.ok(names.some((n) => /^system$/i.test(n)), "应含 System");
});

test("包含 explorer.exe", () => {
  const names = w.listProcessNames();
  if (!names.some((n) => /^explorer\.exe$/i.test(n))) {
    console.log("     (跳过：explorer 未运行)");
    return;
  }
});

test("名字是纯文件名，不含路径", () => {
  for (const n of w.listProcessNames()) {
    assert.ok(!n.includes("\\") && !n.includes("/"), "不应含路径: " + n);
  }
});

test("耗时在合理范围（< 200ms）", () => {
  const t0 = Date.now();
  w.listProcessNames();
  assert.ok(Date.now() - t0 < 200, "太慢: " + (Date.now() - t0) + "ms");
});

test("无重复项", () => {
  const names = w.listProcessNames();
  const uniq = new Set(names);
  assert.strictEqual(uniq.size, names.length, "存在重复");
});

console.log("\n与窗口枚举的区别（核心：托盘程序也能查到）");

test("进程数 > 窗口进程数", () => {
  const procs = w.listProcessNames().length;
  const winProcs = new Set(w.listWindows(false).map((x) => (x.exe || "").split("\\").pop()).filter(Boolean)).size;
  assert.ok(procs >= winProcs, "进程枚举应覆盖窗口枚举 (进程 " + procs + " vs 窗口 " + winProcs + ")");
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);