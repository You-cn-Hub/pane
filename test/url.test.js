/**
 * url.js 单元测试 —— normalizeUrl 是内置浏览器地址栏的核心逻辑。
 * 输入千奇百怪，必须锁住行为。
 */
const assert = require("node:assert");
const { normalizeUrl } = require("../src/modules/url.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}

console.log("已带协议");

test("https 原样返回", () => {
  assert.strictEqual(normalizeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
});

test("http 原样返回", () => {
  assert.strictEqual(normalizeUrl("http://x.com"), "http://x.com");
});

test("file:// 原样返回", () => {
  assert.strictEqual(normalizeUrl("file:///C:/x.html"), "file:///C:/x.html");
});

test("about:blank 原样返回", () => {
  assert.strictEqual(normalizeUrl("about:blank"), "about:blank");
});

console.log("\n本地路径");

test("Windows 盘符路径转 file://", () => {
  assert.strictEqual(normalizeUrl("C:\\Users\\a.html"), "file:///C:/Users/a.html");
});

test("正斜杠路径也认", () => {
  assert.strictEqual(normalizeUrl("D:/x/y.html"), "file:///D:/x/y.html");
});

test("UNC 路径转 file://", () => {
  assert.strictEqual(normalizeUrl("\\\\server\\share\\a.txt"), "file://///server/share/a.txt");
});

console.log("\n本机地址");

test("localhost 补 http", () => {
  assert.strictEqual(normalizeUrl("localhost"), "http://localhost");
});

test("localhost:8080 补 http", () => {
  assert.strictEqual(normalizeUrl("localhost:8080"), "http://localhost:8080");
});

test("127.0.0.1 补 http", () => {
  assert.strictEqual(normalizeUrl("127.0.0.1:3000"), "http://127.0.0.1:3000");
});

console.log("\n域名");

test("裸域名补 http", () => {
  assert.strictEqual(normalizeUrl("example.com"), "http://example.com");
});

test("带路径的域名", () => {
  assert.strictEqual(normalizeUrl("example.com/path"), "http://example.com/path");
});

test("带端口的域名", () => {
  assert.strictEqual(normalizeUrl("example.com:8080"), "http://example.com:8080");
});

test("子域名", () => {
  assert.strictEqual(normalizeUrl("a.b.example.com"), "http://a.b.example.com");
});

console.log("\n边界");

test("空输入返回 null", () => {
  assert.strictEqual(normalizeUrl(""), null);
  assert.strictEqual(normalizeUrl("   "), null);
  assert.strictEqual(normalizeUrl(null), null);
  assert.strictEqual(normalizeUrl(undefined), null);
});

test("纯主机名也拼 http（让它自己报错）", () => {
  assert.strictEqual(normalizeUrl("myserver"), "http://myserver");
});

test("首尾空白被去掉", () => {
  assert.strictEqual(normalizeUrl("  example.com  "), "http://example.com");
});

test("纯中文返回 null（当成搜索词，不是网址）", () => {
  assert.strictEqual(normalizeUrl("这是一句话"), null);
});

test("含空格返回 null", () => {
  assert.strictEqual(normalizeUrl("a b c"), null);
});

test("纯符号返回 null", () => {
  assert.strictEqual(normalizeUrl("///"), null);
  assert.strictEqual(normalizeUrl("???"), null);
});

test("只有协议没有主体时原样返回（由浏览器自己报错）", () => {
  assert.strictEqual(normalizeUrl("http://"), "http://");
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);