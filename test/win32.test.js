/**
 * win32.js 单元测试 —— 只测可脱离真实窗口验证的部分。
 * 真实窗口操作靠集成验证，这里保证降级路径和纯逻辑不出错。
 */
const assert = require("node:assert");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("win32 模块加载");

let w;
test("可以 require 且导出完整", () => {
  w = require("../src/modules/win32.js");
  for (const k of ["isAvailable", "listWindows", "findWindow", "focus", "showWin", "hideWin", "closeWin",
    "sendBottom", "noActivate", "activateWin", "setTopmost", "moveWin", "foreground", "stateOf"]) {
    assert.strictEqual(typeof w[k], "function", "缺函数 " + k);
  }
});

console.log("\n降级与容错");

test("isAvailable 返回布尔", () => {
  assert.strictEqual(typeof w.isAvailable(), "boolean");
});

test("listWindows 返回数组", () => {
  const r = w.listWindows(false);
  assert.ok(Array.isArray(r));
});

test("listWindows 每项结构完整", () => {
  const r = w.listWindows(false);
  if (!r.length) return; // 无窗口环境跳过
  const x = r[0];
  for (const k of ["hWnd", "title", "cls", "pid", "exe", "visible", "rect"]) {
    assert.ok(k in x, "缺字段 " + k);
  }
});

test("findWindow 不存在的进程返回 null", () => {
  assert.strictEqual(w.findWindow({ process: "__no_such_proc__.exe" }), null);
});

test("foreground 结构正确", () => {
  const r = w.foreground();
  assert.strictEqual(typeof r.ok, "boolean");
  if (r.ok) {
    assert.ok("pid" in r);
    assert.ok("exe" in r);
  }
});

test("stateOf 传入 0 不抛异常", () => {
  const r = w.stateOf(0);
  assert.strictEqual(typeof r.ok, "boolean");
});

test("动作函数对无效句柄不抛异常", () => {
  for (const fn of ["focus", "showWin", "hideWin", "closeWin", "sendBottom", "noActivate", "activateWin"]) {
    const r = w[fn](0);
    assert.strictEqual(typeof r.ok, "boolean", fn + " 应返回 {ok}");
  }
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);