/**
 * paths.js 单元测试 —— 不依赖 Electron，直接 node 跑。
 * 按 AGENTS.md「核心逻辑与界面拆分，几秒可验」的要求写。
 */
const assert = require("node:assert");
const path = require("node:path");
const { buildPaths, makeExpander } = require("../src/modules/paths.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("paths.buildPaths");

test("开发模式：DATA_DIR 指向项目根", () => {
  const r = buildPaths({ isPackaged: false, appDir: "/proj", userDataDir: "/ud", resourcesPath: "/res", exeDir: null });
  assert.strictEqual(r.DATA_DIR, "/proj");
  assert.strictEqual(r.IS_PORTABLE, false);
});

test("打包模式：默认便携，数据在 exe 旁 data/", () => {
  const r = buildPaths({ isPackaged: true, appDir: "/app", userDataDir: "/ud", resourcesPath: "/res", exeDir: "/opt/pane" });
  assert.strictEqual(r.IS_PORTABLE, true);
  assert.ok(r.DATA_DIR.endsWith("data"));
});

test("打包但无 exeDir：回落 userData", () => {
  const r = buildPaths({ isPackaged: true, appDir: "/app", userDataDir: "/ud", resourcesPath: "/res", exeDir: null });
  assert.strictEqual(r.DATA_DIR, "/ud");
});

test("RES_DIR 在打包时指向 resources", () => {
  const r = buildPaths({ isPackaged: true, appDir: "/app", userDataDir: "/ud", resourcesPath: "/res", exeDir: "/x" });
  assert.strictEqual(r.RES_DIR, "/res");
});

test("未打包时 RES_DIR 与 APP_DIR 相同", () => {
  const r = buildPaths({ isPackaged: false, appDir: "/proj", userDataDir: "/ud", resourcesPath: "/res", exeDir: null });
  assert.strictEqual(r.RES_DIR, "/proj");
});

test("各派生路径都基于 DATA_DIR", () => {
  const r = buildPaths({ isPackaged: false, appDir: "/proj", userDataDir: "/ud", resourcesPath: "/res", exeDir: null });
  // 用与实现相同的方式构造期望值（path.join 在 Windows 不加盘符）
  assert.strictEqual(path.dirname(r.SETTINGS_FILE), path.join("/proj"), "settings 应在 DATA_DIR 下");
  assert.ok(r.PLUGIN_DIR.includes("plugins"), "PLUGIN_DIR 应含 plugins");
  assert.ok(r.POS_FILE.includes("_pos.json"), "POS_FILE 应是 _pos.json");
  assert.ok(r.ICON_LOG.includes("_icon.log"), "ICON_LOG 应是 _icon.log");
});

console.log("\npaths.makeExpander");

test("展开 ${app} ${res} ${home}", () => {
  const ex = makeExpander({ APP_DIR: "/app", RES_DIR: "/res", SERVER_DIR: "/srv", home: "/home/u" });
  assert.strictEqual(ex("${app}/x"), "/app/x");
  assert.strictEqual(ex("${res}/y"), "/res/y");
  const os = require("node:os");
  const exReal = makeExpander({ APP_DIR: "/app", RES_DIR: "/res", SERVER_DIR: "/srv", home: os.homedir() });
  assert.strictEqual(exReal("${home}"), os.homedir());
});

test("未知占位符原样保留", () => {
  const ex = makeExpander({ APP_DIR: "/app" });
  assert.strictEqual(ex("${nope}/x"), "${nope}/x");
});

test("空值与非字符串直接返回", () => {
  const ex = makeExpander({ APP_DIR: "/app" });
  assert.strictEqual(ex(""), "");
  assert.strictEqual(ex(null), null);
  assert.strictEqual(ex(123), 123);
});

test("无占位符的字符串原样返回", () => {
  const ex = makeExpander({ APP_DIR: "/app" });
  assert.strictEqual(ex("/plain/path"), "/plain/path");
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);