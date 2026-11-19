/**
 * updatefeed 单元测试 —— 纯字符串与版本逻辑，不联网。
 * 真实的「能不能下下来」靠真机验证（github.com 在这台机器上是断的）。
 */
const assert = require("node:assert");
const {
  compareVersion,
  pickAsset,
  mirrorUrl,
  parseRelease,
  MIRRORS,
} = require("../src/modules/updatefeed.js");

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
    pass++;
  } catch (e) {
    console.log("  ✗", name, "\n     ", e.message);
    fail++;
  }
}

console.log("compareVersion");
test("1.1.1 > 1.1.0", () => assert.strictEqual(compareVersion("1.1.1", "1.1.0"), 1));
test("1.1.0 = v1.1.0", () => assert.strictEqual(compareVersion("v1.1.0", "1.1.0"), 0));
test("1.0.9 < 1.1.0", () => assert.strictEqual(compareVersion("1.0.9", "1.1.0"), -1));
test("1.1 = 1.1.0", () => assert.strictEqual(compareVersion("1.1", "1.1.0"), 0));
test("2.0.0 > 1.99.99", () => assert.strictEqual(compareVersion("2.0.0", "1.99.99"), 1));
test("带 -beta 尾巴不影响", () => assert.strictEqual(compareVersion("1.2.0-beta.1", "1.2.0"), 0));
test("空值当 0.0.0", () => assert.strictEqual(compareVersion("", "1.0.0"), -1));

console.log("pickAsset");
test("优先 Pane-Setup 安装包", () => {
  const a = pickAsset({
    assets: [
      { name: "Pane-1.2.0-win-x64-portable.zip", browser_download_url: "u1" },
      { name: "Pane-Setup-1.2.0.exe", browser_download_url: "u2" },
      { name: "latest.yml", browser_download_url: "u3" },
    ],
  });
  assert.strictEqual(a.browser_download_url, "u2");
});
test("没有 Setup 时退到任意 exe", () => {
  const a = pickAsset({ assets: [{ name: "Pane-portable.exe", browser_download_url: "u1" }] });
  assert.strictEqual(a.name, "Pane-portable.exe");
});
test("没有 exe 返回 null", () => {
  assert.strictEqual(pickAsset({ assets: [{ name: "x.zip" }] }), null);
});
test("空对象不炸", () => assert.strictEqual(pickAsset(null), null));

console.log("mirrorUrl");
test("空前缀就是原地址", () => {
  assert.strictEqual(mirrorUrl("", "https://github.com/a/b"), "https://github.com/a/b");
});
test("前缀自动补斜杠", () => {
  assert.strictEqual(
    mirrorUrl("https://gh-proxy.com", "https://github.com/a/b"),
    "https://gh-proxy.com/https://github.com/a/b"
  );
});
test("已有斜杠不重复加", () => {
  assert.strictEqual(
    mirrorUrl("https://gh-proxy.com/", "https://github.com/a/b"),
    "https://gh-proxy.com/https://github.com/a/b"
  );
});
test("直连在候选列表第一位", () => assert.strictEqual(MIRRORS[0], ""));
test("候选里至少有一个镜像", () => assert.ok(MIRRORS.length >= 2));

console.log("parseRelease");
const rel = (tag, extra = {}) =>
  Object.assign(
    {
      tag_name: tag,
      assets: [{ name: `Pane-Setup-${tag.replace(/^v/, "")}.exe`, browser_download_url: "https://github.com/x/y.exe" }],
      body: "改动说明",
    },
    extra
  );

test("新版本可用", () => {
  const r = parseRelease(rel("v1.2.0"), "1.1.0");
  assert.strictEqual(r.hasUpdate, true);
  assert.strictEqual(r.version, "1.2.0");
  assert.ok(r.asset);
});
test("同版本不更新", () => {
  assert.strictEqual(parseRelease(rel("v1.1.0"), "1.1.0").hasUpdate, false);
});
test("旧版本不更新", () => {
  assert.strictEqual(parseRelease(rel("v1.0.0"), "1.1.0").hasUpdate, false);
});
test("预发布跳过", () => {
  assert.strictEqual(parseRelease(rel("v1.2.0", { prerelease: true }), "1.1.0").hasUpdate, false);
});
test("草稿跳过", () => {
  assert.strictEqual(parseRelease(rel("v1.2.0", { draft: true }), "1.1.0").hasUpdate, false);
});
test("没有 exe 资产就不算可更新", () => {
  const r = parseRelease({ tag_name: "v1.2.0", assets: [] }, "1.1.0");
  assert.strictEqual(r.hasUpdate, false);
});
test("响应为空不炸", () => {
  const r = parseRelease(null, "1.1.0");
  assert.strictEqual(r.hasUpdate, false);
});
test("说明截到 800 字", () => {
  const r = parseRelease(rel("v1.2.0", { body: "x".repeat(2000) }), "1.1.0");
  assert.strictEqual(r.notes.length, 800);
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);
