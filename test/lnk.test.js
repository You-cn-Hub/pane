/**
 * lnk.js 单元测试 —— .lnk 解析必须准确，否则添加的条目指向错误程序。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseLnk } = require("../src/modules/lnk.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("错误处理");

test("文件不存在返回 ok:false", () => {
  const r = parseLnk("C:\\__no_such_file__.lnk");
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test("太小的文件被拒绝", () => {
  const tmp = path.join(os.tmpdir(), "pane-tiny.lnk");
  fs.writeFileSync(tmp, Buffer.alloc(10));
  const r = parseLnk(tmp);
  assert.strictEqual(r.ok, false);
  fs.unlinkSync(tmp);
});

test("头长度不对被拒绝", () => {
  const tmp = path.join(os.tmpdir(), "pane-bad.lnk");
  const buf = Buffer.alloc(200);
  buf.writeUInt32LE(0x99, 0); // 不是 0x4C
  fs.writeFileSync(tmp, buf);
  const r = parseLnk(tmp);
  assert.strictEqual(r.ok, false);
  fs.unlinkSync(tmp);
});

console.log("\n真实快捷方式（存在才测）");

const desktop = path.join(os.homedir(), "Desktop");
if (fs.existsSync(desktop)) {
  const lnks = fs.readdirSync(desktop).filter((f) => f.endsWith(".lnk"));
  test("桌面上至少有一个 .lnk，解析成功率 > 0", () => {
    if (!lnks.length) return;
    const results = lnks.map((f) => parseLnk(path.join(desktop, f)));
    const okCount = results.filter((r) => r.ok).length;
    assert.ok(okCount > 0, "一个都没解析成功");
  });

  test("解析成功的目标路径都有盘符", () => {
    if (!lnks.length) return;
    for (const f of lnks) {
      const r = parseLnk(path.join(desktop, f));
      if (!r.ok) continue;
      assert.ok(/^[A-Za-z]:/.test(r.target) || r.target.startsWith("\\\\"),
        f + " 的目标路径异常: " + r.target);
    }
  });
}

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);