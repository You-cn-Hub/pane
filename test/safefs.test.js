/**
 * safefs.js 单元测试 —— 验证原子写入、备份滚动、损坏文件保留。
 * 用系统临时目录，不碰真实数据。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic, writeFileSafe, backupFile, readJsonSafe, cleanupTempFiles, BACKUP_KEEP } = require("../src/modules/safefs.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pane-safefs-"));
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log("writeFileAtomic");

test("写入新文件内容正确", () => {
  const f = path.join(TMP, "a.json");
  writeFileAtomic(f, JSON.stringify({ x: 1 }));
  assert.strictEqual(fs.readFileSync(f, "utf-8"), '{"x":1}');
});

test("覆盖已有文件", () => {
  const f = path.join(TMP, "b.json");
  writeFileAtomic(f, "old");
  writeFileAtomic(f, "new");
  assert.strictEqual(fs.readFileSync(f, "utf-8"), "new");
});

test("写入后不残留临时文件", () => {
  const dir = path.join(TMP, "clean");
  writeFileAtomic(path.join(dir, "c.json"), "x");
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.strictEqual(leftovers.length, 0);
});

test("自动创建不存在的目录", () => {
  const f = path.join(TMP, "deep", "nested", "d.json");
  writeFileAtomic(f, "ok");
  assert.ok(fs.existsSync(f));
});

console.log("\nbackupFile");

test("备份生成到 _backup/", () => {
  const f = path.join(TMP, "e.json");
  writeFileAtomic(f, "v1");
  const bk = backupFile(f);
  assert.ok(bk && fs.existsSync(bk));
  assert.ok(bk.includes("_backup"));
});

test("备份保留内容一致", () => {
  const f = path.join(TMP, "f.json");
  writeFileAtomic(f, '{"v":2}');
  const bk = backupFile(f);
  assert.strictEqual(fs.readFileSync(bk, "utf-8"), '{"v":2}');
});

test("备份滚动只留 BACKUP_KEEP 份", () => {
  const dir = path.join(TMP, "roll");
  const f = path.join(dir, "g.json");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < BACKUP_KEEP + 3; i++) {
    writeFileAtomic(f, "v" + i);
    backupFile(f);
  }
  const bks = fs.readdirSync(path.join(dir, "_backup")).filter((x) => x.endsWith(".bak"));
  assert.ok(bks.length <= BACKUP_KEEP, "备份数 " + bks.length + " 应 <= " + BACKUP_KEEP);
});

test("备份不存在的文件返回 null", () => {
  assert.strictEqual(backupFile(path.join(TMP, "nope.json")), null);
});

console.log("\nwriteFileSafe");

test("覆盖前自动备份旧内容", () => {
  const f = path.join(TMP, "h.json");
  writeFileSafe(f, "first");
  writeFileSafe(f, "second");
  const bks = fs.readdirSync(path.join(TMP, "_backup")).filter((x) => x.startsWith("h.json"));
  assert.ok(bks.length >= 1, "应有备份");
  const newest = bks.sort().pop();
  assert.strictEqual(fs.readFileSync(path.join(TMP, "_backup", newest), "utf-8"), "first");
});

console.log("\nreadJsonSafe");

test("正常 JSON 解析成功", () => {
  const f = path.join(TMP, "ok.json");
  writeFileAtomic(f, '{"a":1}');
  const r = readJsonSafe(f);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.a, 1);
});

test("损坏 JSON 被改名保留，返回 ok:false", () => {
  const f = path.join(TMP, "bad.json");
  writeFileAtomic(f, "{ broken");
  const r = readJsonSafe(f);
  assert.strictEqual(r.ok, false);
  assert.ok(r.corrupt, "应返回 corrupt 路径");
  assert.ok(fs.existsSync(r.corrupt), "坏文件应保留");
  assert.ok(!fs.existsSync(f), "原文件应已改名");
});

test("文件不存在返回 not_found", () => {
  const r = readJsonSafe(path.join(TMP, "missing.json"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "not_found");
});

test("空文件不算损坏", () => {
  const f = path.join(TMP, "empty.json");
  writeFileAtomic(f, "   ");
  const r = readJsonSafe(f);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "empty");
  assert.strictEqual(r.corrupt, null);
});

console.log("\ncleanupTempFiles");

test("清理已死进程的临时文件", () => {
  const dir = path.join(TMP, "tmpclean");
  fs.mkdirSync(dir, { recursive: true });
  // 用一个几乎不可能存在的 pid
  fs.writeFileSync(path.join(dir, ".x.json.999999.123.tmp"), "junk");
  const n = cleanupTempFiles(dir);
  assert.ok(n >= 1, "应清理至少 1 个");
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("不清理当前存活进程的临时文件", () => {
  const dir = path.join(TMP, "tmpkeep");
  fs.mkdirSync(dir, { recursive: true });
  const name = `.y.json.${process.pid}.123.tmp`;
  fs.writeFileSync(path.join(dir, name), "live");
  cleanupTempFiles(dir);
  assert.ok(fs.existsSync(path.join(dir, name)), "存活进程的临时文件应保留");
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
cleanup();
process.exit(fail > 0 ? 1 : 0);