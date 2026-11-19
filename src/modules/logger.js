/**
 * 日志 —— 用户那边没有控制台，关键信息必须落到文件里。
 *
 * 分两路：
 *   trace  排查用的打点，只在 WB_TRACE=1 时写
 *   error  真出错了，必须让用户能自己找到
 *
 * 落盘策略：
 *   - 统一写到 data/logs/app-YYYY-MM-DD.log，按天分文件
 *   - 启动时清理超过 7 天的旧日志，避免无限增长
 *   - 写日志本身失败必须吞掉，日志不能成为新的故障点
 */

const fs = require("fs");
const path = require("path");

/** 日志保留天数 */
const KEEP_DAYS = 7;

/**
 * @param {object} deps
 * @param {string} deps.logDir   日志目录
 * @param {boolean} deps.enabled 是否开启 trace
 */
function createLogger(deps) {
  const { logDir: LOG_DIR, enabled = false } = deps || {};
  let dirReady = false;

  function ensureDir() {
    if (dirReady || !LOG_DIR) return dirReady;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      dirReady = true;
    } catch {
      dirReady = false;
    }
    return dirReady;
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fileForToday() {
    if (!LOG_DIR) return null;
    return path.join(LOG_DIR, `app-${today()}.log`);
  }

  function write(level, msg, err) {
    const detail = err ? " " + (err.stack || err.message || String(err)) : "";
    const line = `[${new Date().toISOString()}] [${level}] ${msg}${detail}\n`;
    // 控制台：开发和带控制台的场景可见
    try {
      if (level === "ERROR") console.error(line.trim());
      else if (enabled) console.log(line.trim());
    } catch {}
    // 文件：全都写。用户那边没有控制台，日志是唯一能拿到现场的地方；
    // 只写 ERROR 时「点了一下没反应」这类问题根本无从查起。
    // 量不大（一天几十 KB），保留 7 天自动清。
    if (!ensureDir()) return;
    try {
      fs.appendFileSync(fileForToday(), line, "utf-8");
    } catch {}
  }

  /** 清理过期日志 */
  function cleanup() {
    if (!ensureDir()) return 0;
    let removed = 0;
    try {
      const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        const full = path.join(LOG_DIR, f);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {}
      }
    } catch {}
    return removed;
  }

  return {
    trace: (msg, err) => write("TRACE", msg, err),
    info: (msg, err) => write("INFO", msg, err),
    warn: (msg, err) => write("WARN", msg, err),
    error: (msg, err) => write("ERROR", msg, err),
    cleanup,
    get dir() {
      return LOG_DIR;
    },
    get currentFile() {
      return fileForToday();
    },
  };
}

module.exports = { createLogger, KEEP_DAYS };