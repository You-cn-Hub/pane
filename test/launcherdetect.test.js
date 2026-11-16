/**
 * launcherdetect.js 单元测试
 */
const assert = require("node:assert");
const { looksLikeLauncher, rootOf, pickRealProcess } = require("../src/modules/launcherdetect.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("looksLikeLauncher");

test("Launcher 结尾被识别", () => {
  assert.strictEqual(looksLikeLauncher("SodaMusicLauncher.exe"), true);
});

test("普通程序不被误判", () => {
  for (const n of ["Steam.exe", "QQ.exe", "chrome.exe", "Weixin.exe"]) {
    assert.strictEqual(looksLikeLauncher(n), false, n + " 不该被判为启动器");
  }
});

test("bootstrap / stub 也识别", () => {
  assert.strictEqual(looksLikeLauncher("appBootstrap.exe"), true);
  assert.strictEqual(looksLikeLauncher("x86stub.exe"), true);
});

test("空值不崩溃", () => {
  assert.strictEqual(looksLikeLauncher(""), false);
  assert.strictEqual(looksLikeLauncher(null), false);
});

console.log("\nrootOf");

test("去掉 Launcher 后词根一致", () => {
  assert.strictEqual(rootOf("SodaMusicLauncher.exe"), rootOf("SodaMusic.exe"));
});

test("大小写无关", () => {
  assert.strictEqual(rootOf("SodaMusic.EXE"), "sodamusic");
});

test("分隔符被去掉", () => {
  assert.strictEqual(rootOf("soda-music.exe"), "sodamusic");
});

console.log("\npickRealProcess");

test("从进程列表里挑出真实主程序", () => {
  const r = pickRealProcess(["SodaMusic.exe", "SodaMusicLauncher.exe", "explorer.exe"], "SodaMusicLauncher.exe");
  assert.strictEqual(r, "SodaMusic.exe");
});

test("只有启动器时返回 null 或启动器本身", () => {
  const r = pickRealProcess(["SodaMusicLauncher.exe"], "SodaMusicLauncher.exe");
  // 只有启动器在跑，说明主程序还没起来
  assert.ok(r === null || /launcher/i.test(r));
});

test("无关进程不被误选", () => {
  const r = pickRealProcess(["chrome.exe", "notepad.exe"], "SodaMusicLauncher.exe");
  assert.strictEqual(r, null);
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);