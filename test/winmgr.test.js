/**
 * winmgr 桥接层测试 —— 重点验证原生命令分发，不依赖 Python。
 */
const assert = require("node:assert");
const { createWinMgr } = require("../src/modules/winmgr.js");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

(async () => {
  const wm = createWinMgr({ winmgrPath: "", cwd: __dirname, log: () => {} });

  console.log("probe 与原生可用性");

  await test("probe 返回 ok:true（原生可用）", async () => {
    const r = await wm.probe();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.native, true);
  });

  console.log("\nprocs");

  await test("procs 返回进程名数组", async () => {
    const r = await wm.run(["procs"]);
    assert.strictEqual(r.ok, true);
    assert.ok(Array.isArray(r.procs));
    assert.ok(r.procs.length > 0, "应有正在运行的窗口进程");
  });

  await test("procs 结果不含路径，只有文件名", async () => {
    const r = await wm.run(["procs"]);
    for (const p of r.procs) assert.ok(!p.includes("\\"), p + " 不应含路径");
  });

  console.log("\nfg");

  await test("fg 返回前台进程信息", async () => {
    const r = await wm.run(["fg"]);
    assert.strictEqual(r.ok, true);
    assert.ok("exe" in r);
  });

  console.log("\nkill 容错");

  await test("kill 不存在的进程返回 ok:true 但 killed:false", async () => {
    const r = await wm.run(["kill", "--process", "__no_such_proc__.exe"]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.killed, false);
  });

  console.log("\nlnk 解析");

  await test("lnk 缺参数返回错误", async () => {
    const r = await wm.run(["lnk"]);
    assert.strictEqual(r.ok, false);
  });

  await test("lnk 指向不存在的文件返回错误", async () => {
    const r = await wm.run(["lnk", "--src", "C:\\__no_such__.lnk"]);
    assert.strictEqual(r.ok, false);
  });

  console.log("\nkillport");

  await test("killport 缺端口参数返回错误", async () => {
    const r = await wm.run(["killport"]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "missing_port");
  });

  console.log("\nfindArgs");

  await test("findArgs 拼出正确的窗口查找参数", () => {
    const a = wm.findArgs({ find: { process: "a.exe", title: "x" } });
    assert.strictEqual(a[0], "find");
    assert.ok(a.includes("--process"));
    assert.ok(a.includes("a.exe"));
    assert.ok(a.includes("--title"));
  });

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail > 0 ? 1 : 0);
})();