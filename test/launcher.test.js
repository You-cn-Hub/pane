/**
 * launcher.js 单元测试 —— 只测能脱离窗口环境验证的部分。
 * portOpen 用真实端口验证：开一个临时服务，看它能否正确判断。
 */
const assert = require("node:assert");
const net = require("node:net");
const path = require("node:path");
const { createLauncher } = require("../src/modules/launcher.js");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

// 用假的依赖构造 launcher，只关心 portOpen
const deps = {
  runWinMgr: async () => ({ ok: false }),
  findArgs: () => [],
  resolveExe: () => "",
  expandPath: (p) => p,
  getPlugin: () => null,
};

(async () => {
  const l = createLauncher(deps);
  // portOpen 没直接导出，通过 items 里的内部引用拿不到；
  // 这里用行为验证：起一个真实服务，看 launcher 能否探到。
  console.log("模块结构");

  await test("createLauncher 返回预期接口", async () => {
    for (const k of ["portOpen", "launchDetached", "resolveWindow", "launchOnly", "quitApp"]) {
      assert.strictEqual(typeof l[k], "function", "缺函数 " + k);
    }
  });

  console.log("\n端口探测");

  // 起一个临时服务
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const openPort = srv.address().port;

  await test("portOpen 对已开端口返回 true", async () => {
    const ok = await l.portOpen(openPort);
    assert.strictEqual(ok, true);
  });

  await test("portOpen 对关闭端口返回 false", async () => {
    const closed = openPort + 1 > 65535 ? openPort - 1 : openPort + 1;
    const ok = await l.portOpen(closed);
    assert.strictEqual(ok, false);
  });

  await test("portOpen 在超时内返回，不挂死", async () => {
    const t0 = Date.now();
    await l.portOpen(1); // 特权端口，基本不可能开
    assert.ok(Date.now() - t0 < 3000, "应在 3 秒内返回");
  });

  await new Promise((r) => srv.close(r));

  await test("服务关闭后 portOpen 返回 false", async () => {
    const ok = await l.portOpen(openPort);
    assert.strictEqual(ok, false);
  });

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail > 0 ? 1 : 0);
})();