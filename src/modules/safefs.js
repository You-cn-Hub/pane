/**
 * 安全文件操作 —— 全项目唯一的写文件入口。
 *
 * 为什么需要这个模块：
 *   直接 writeFileSync 覆盖原文件，写到一半断电 / 杀进程 / 磁盘满，
 *   目标文件就成了半截 JSON。而读取侧解析失败通常只能丢弃，等于用户数据丢了。
 *
 * 做法：
 *   1. 写临时文件 → fsync → rename 覆盖。同盘 rename 是原子操作，要么旧的要么新的，没有中间态。
 *   2. rename 之前先备份一份上一版，读取解析失败时可以回滚。
 *   3. 解析失败的文件改名成 .corrupt 保留，而不是静默丢弃，方便事后人工捞。
 */

const fs = require("fs");
const path = require("path");

/** 备份保留份数 */
const BACKUP_KEEP = 3;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}

/**
 * 原子写入：先写同目录临时文件，fsync 落盘，再 rename 覆盖。
 * @param {string} file 目标文件绝对路径
 * @param {string} data 文件内容
 */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, data, "utf-8");
    // 确保内容真的落盘，否则 rename 之后可能还是空文件
    try {
      fs.fsyncSync(fd);
    } catch {}
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // rename 失败（跨盘、权限）时清掉临时文件，别留垃圾
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/** 备份目录：<dir>/_backup */
function backupDirOf(file) {
  return path.join(path.dirname(file), "_backup");
}

/**
 * 把当前文件复制一份到 _backup/，按时间戳命名，只保留最近 BACKUP_KEEP 份。
 * 文件不存在时静默返回。
 */
function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const dir = backupDirOf(file);
  ensureDir(dir);
  const base = path.basename(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${base}.${stamp}.bak`);
  try {
    fs.copyFileSync(file, dest);
  } catch {
    return null;
  }
  // 滚动清理：同一文件的备份只留最近几份
  try {
    const mine = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + ".") && f.endsWith(".bak"))
      .sort();
    while (mine.length > BACKUP_KEEP) {
      const old = mine.shift();
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {}
    }
  } catch {}
  return dest;
}

/**
 * 带备份的原子写入。覆盖前先把旧版本存进 _backup/。
 */
function writeFileSafe(file, data) {
  backupFile(file);
  writeFileAtomic(file, data);
}

/**
 * 读取 JSON。解析失败时：
 *   - 把坏文件改名成 .corrupt 保留下来（不删，方便人工恢复）
 *   - 返回 { ok: false, error }，由调用方决定怎么处理
 * @returns {{ok:true,data:any}|{ok:false,error:string,corrupt:string|null}}
 */
function readJsonSafe(file) {
  if (!fs.existsSync(file)) return { ok: false, error: "not_found", corrupt: null };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    return { ok: false, error: e.message, corrupt: null };
  }
  // 空文件视为没数据，不算损坏
  if (!text.trim()) return { ok: false, error: "empty", corrupt: null };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    // 损坏：改名保留，不删
    const corrupt = file + ".corrupt-" + Date.now();
    try {
      fs.renameSync(file, corrupt);
    } catch {
      return { ok: false, error: e.message, corrupt: null };
    }
    return { ok: false, error: e.message, corrupt };
  }
}

/**
 * 清理上次异常退出遗留的临时文件（进程号已不存在的那种）。
 */
function cleanupTempFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(".") || !f.endsWith(".tmp")) continue;
      const parts = f.split(".");
      const pid = Number(parts[parts.length - 3]);
      let alive = false;
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (!alive) {
        try {
          fs.unlinkSync(path.join(dir, f));
          n++;
        } catch {}
      }
    }
  } catch {}
  return n;
}

module.exports = { writeFileAtomic, writeFileSafe, backupFile, readJsonSafe, cleanupTempFiles, ensureDir, BACKUP_KEEP };