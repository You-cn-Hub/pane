/**
 * logger.js 单元测试 —— 验证分级落盘、按天分文件、过期清理。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLogger, KEEP_DAYS } = require("../src/modules/logger.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pane-log-"));
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
}
function reset() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TMP, { recursive: true });
}

console.log("基础写入");

test("error 即使 trace 关闭也会落盘", () => {
  reset();
  const log = createLogger({ logDir: TMP, enabled: false });
  log.error("出错了", new Error("boom"));
  const f = log.currentFile;
  assert.ok(fs.existsSync(f), "日志文件应存在");
  const content = fs.readFileSync(f, "utf-8");
  assert.ok(content.includes("[ERROR]"), "应含 ERROR 标记");
  assert.ok(content.includes("出错了"), "应含消息");
  assert.ok(content.includes("boom"), "应含错误详情");
});

test("trace 关闭时也落盘（用户那边没有控制台，日志是唯一现场）", () => {
  reset();
  const log = createLogger({ logDir: TMP, enabled: false });
  log.trace("调试信息");
  const f = log.currentFile;
  assert.ok(fs.existsSync(f), "应生成文件");
  assert.ok(fs.readFileSync(f, "utf-8").includes("[TRACE] 调试信息"));
});

test("trace 开启时会写文件", () => {
  reset();
  const log = createLogger({ logDir: TMP, enabled: true });
  log.trace("调试信息");
  const f = log.currentFile;
  assert.ok(fs.existsSync(f));
  assert.ok(fs.readFileSync(f, "utf-8").includes("[TRACE]"));
});

test("文件名按天", () => {
  reset();
  const log = createLogger({ logDir: TMP, enabled: true });
  log.info("x");
  const f = log.currentFile;
  assert.ok(/app-\d{4}-\d{2}-\d{2}\.log$/.test(f), "文件名格式不对: " + f);
});

console.log("\n过期清理");

test("清理超过 KEEP_DAYS 的日志", () => {
  reset();
  const old = path.join(TMP, "app-2020-01-01.log");
  fs.writeFileSync(old, "old");
  const oldTime = Date.now() - (KEEP_DAYS + 2) * 24 * 3600 * 1000;
  fs.utimesSync(old, new Date(oldTime), new Date(oldTime));
  const log = createLogger({ logDir: TMP, enabled: true });
  const n = log.cleanup();
  assert.strictEqual(n, 1, "应删除 1 个");
  assert.ok(!fs.existsSync(old));
});

test("不清理保留期内的日志", () => {
  reset();
  const recent = path.join(TMP, "app-2999-01-01.log");
  fs.writeFileSync(recent, "keep");
  const log = createLogger({ logDir: TMP, enabled: true });
  const n = log.cleanup();
  assert.strictEqual(n, 0);
  assert.ok(fs.existsSync(recent));
});

test("不碰非日志文件", () => {
  reset();
  const other = path.join(TMP, "settings.json");
  fs.writeFileSync(other, "{}");
  const oldTime = Date.now() - 30 * 24 * 3600 * 1000;
  fs.utimesSync(other, new Date(oldTime), new Date(oldTime));
  const log = createLogger({ logDir: TMP, enabled: true });
  log.cleanup();
  assert.ok(fs.existsSync(other), "非日志文件不应被删");
});

console.log("\n容错");

test("目录不可写时不抛异常", () => {
  const log = createLogger({ logDir: "Z:\\nonexistent\\path", enabled: true });
  log.error("x");
  log.trace("y");
  assert.ok(true);
});

test("无 logDir 时不抛异常", () => {
  const log = createLogger({ enabled: true });
  log.error("x");
  assert.strictEqual(log.currentFile, null);
});

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
reset();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);