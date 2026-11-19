/**
 * shelf 单元测试 —— 用临时文件当数据文件，exists 注入假值。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createShelf, MAX } = require("../src/modules/shelf.js");

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-shelf-"));
const shelfFile = path.join(dir, "shelf.json");
const alive = new Set(["C:\\a\\1.txt", "C:\\a\\2.pdf"]);
const mk = () => createShelf({ shelfFile, exists: (p) => alive.has(p) });

console.log("基础");

test("空文件返回空列表", () => {
  assert.deepStrictEqual(mk().list(), []);
});

test("加一条", () => {
  const s = mk();
  const r = s.add(["C:\\a\\1.txt"]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 1);
  const l = s.list();
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].name, "1.txt");
  assert.strictEqual(l[0].ext, "txt");
  assert.strictEqual(l[0].exists, true);
});

test("新的排前面", () => {
  const s = mk();
  s.add(["C:\\a\\2.pdf"]);
  assert.strictEqual(s.list()[0].path, "C:\\a\\2.pdf");
  assert.strictEqual(s.list().length, 2);
});

test("重复路径跳过（不分大小写）", () => {
  const s = mk();
  const r = s.add(["c:\\A\\1.txt"]);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(s.list().length, 2);
});

test("文件没了标 exists=false", () => {
  const s = mk();
  alive.delete("C:\\a\\2.pdf");
  const item = s.list().find((x) => x.name === "2.pdf");
  assert.strictEqual(item.exists, false);
  alive.add("C:\\a\\2.pdf");
});

test("删一条", () => {
  const s = mk();
  s.remove("C:\\a\\1.txt");
  assert.strictEqual(s.list().length, 1);
  assert.strictEqual(s.list()[0].name, "2.pdf");
});

test("清理失效", () => {
  const s = mk();
  s.add(["C:\\a\\1.txt"]);
  alive.delete("C:\\a\\1.txt");
  const r = s.prune();
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(s.list().length, 1);
  alive.add("C:\\a\\1.txt");
});

test("清空", () => {
  const s = mk();
  s.clear();
  assert.deepStrictEqual(s.list(), []);
});

test("上限 MAX 条，超出的丢最老的", () => {
  const s = mk();
  const many = [];
  for (let i = 0; i < MAX + 5; i++) many.push(`C:\\b\\${i}.txt`);
  s.add(many);
  const l = s.list();
  assert.strictEqual(l.length, MAX);
  assert.strictEqual(l[0].name, `${MAX + 4}.txt`);
});

test("坏 JSON 不炸，当空处理", () => {
  fs.writeFileSync(shelfFile, "{oops");
  const s = createShelf({ shelfFile, exists: () => true });
  assert.deepStrictEqual(s.list(), []);
});

test("写进去能被新实例读出来", () => {
  const s1 = createShelf({ shelfFile: path.join(dir, "s2.json"), exists: () => true });
  s1.add(["C:\\x\\y.txt"]);
  const s2 = createShelf({ shelfFile: path.join(dir, "s2.json"), exists: () => true });
  assert.strictEqual(s2.list()[0].path, "C:\\x\\y.txt");
});

test("空输入不报错", () => {
  const s = mk();
  const r = s.add([]);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(s.add([""]).added, 0);
});

fs.rmSync(dir, { recursive: true, force: true });

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail > 0 ? 1 : 0);
