/**
 * naming.js 单元测试 —— slugify 与 pickColor 是纯函数，必须锁住行为。
 */
const assert = require("node:assert");
const { slugify, pickColor, PALETTE } = require("../src/modules/naming.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("slugify");

test("普通英文名", () => {
  assert.strictEqual(slugify("Visual Studio Code"), "visual-studio-code");
});

test("中文名保留", () => {
  assert.strictEqual(slugify("微信"), "微信");
});

test("中英混合", () => {
  assert.strictEqual(slugify("微信 WeChat"), "微信-wechat");
});

test("连续符号压成一个连字符", () => {
  assert.strictEqual(slugify("a___b"), "a-b");
});

test("首尾连字符被去掉", () => {
  assert.strictEqual(slugify("--hello--"), "hello");
});

test("全是符号时回退 app", () => {
  assert.strictEqual(slugify("!!!"), "app");
});

test("空字符串回退 app", () => {
  assert.strictEqual(slugify(""), "app");
});

test("null / undefined 回退 app", () => {
  assert.strictEqual(slugify(null), "app");
  assert.strictEqual(slugify(undefined), "app");
});

test("大写转小写", () => {
  assert.strictEqual(slugify("HELLO"), "hello");
});

test("数字保留", () => {
  assert.strictEqual(slugify("App 2024"), "app-2024");
});

console.log("\npickColor");

test("同名结果稳定", () => {
  const a = pickColor("vscode");
  const b = pickColor("vscode");
  assert.strictEqual(a, b);
});

test("返回值必须在色板里", () => {
  for (const name of ["a", "b", "微信", "chrome", "x".repeat(100)]) {
    assert.ok(PALETTE.includes(pickColor(name)), name + " 得到非法颜色");
  }
});

test("不同名字倾向不同颜色", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const colors = new Set(names.map(pickColor));
  assert.ok(colors.size >= 2, "8 个不同名字应至少得到 2 种颜色");
});

test("空值不崩溃", () => {
  assert.ok(PALETTE.includes(pickColor(null)));
  assert.ok(PALETTE.includes(pickColor("")));
});

test("色板长度稳定", () => {
  assert.strictEqual(PALETTE.length, 8);
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);