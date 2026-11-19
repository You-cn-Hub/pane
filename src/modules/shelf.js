/**
 * 文件中转架 —— 只记路径，不复制文件。
 *
 * 用法：把文件拖进窗格暂存，切到别的窗口再拖出去（或复制路径、打开、定位）。
 * 为什么不复制：动辄几百 MB 的文件复制一份既慢又占盘，用户要的其实只是「等会儿还要用」。
 *
 * 数据：data/shelf.json，一个数组。上限 MAX 条，超出从最早的开始丢。
 */

const fs = require("fs");
const path = require("path");
const { writeFileSafe, readJsonSafe } = require("./safefs");

const MAX = 20;

/**
 * @param {object} deps
 * @param {string} deps.shelfFile  数据文件路径
 * @param {Function} [deps.exists] 判断路径还在不在（测试时可注入）
 */
function createShelf(deps) {
  const { shelfFile, exists = (p) => fs.existsSync(p) } = deps;
  let cache = null;

  function load() {
    if (cache) return cache;
    const r = readJsonSafe(shelfFile);
    const raw = r.ok && Array.isArray(r.data) ? r.data : [];
    cache = raw
      .filter((x) => x && typeof x.path === "string" && x.path)
      .slice(0, MAX)
      .map((x) => ({
        path: x.path,
        name: x.name || path.basename(x.path),
        addedAt: Number(x.addedAt) || 0,
      }));
    return cache;
  }

  function save(list) {
    cache = list.slice(0, MAX);
    try {
      writeFileSafe(shelfFile, JSON.stringify(cache, null, 2));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 列表：带上「文件还在不在」，界面据此灰显 */
  function list() {
    return load().map((x) => ({
      path: x.path,
      name: x.name,
      dir: path.dirname(x.path),
      ext: (path.extname(x.path) || "").replace(".", "").toLowerCase(),
      addedAt: x.addedAt,
      exists: !!exists(x.path),
    }));
  }

  /**
   * 加入一批路径。重复的（同一路径）跳过，最多保留 MAX 条。
   * @returns {{ok:boolean, added:number, skipped:number}}
   */
  function add(paths) {
    const list = load().slice();
    let added = 0;
    let skipped = 0;
    for (const p of paths || []) {
      const raw = String(p || "").trim();
      if (!raw) continue;
      if (list.some((x) => x.path.toLowerCase() === raw.toLowerCase())) {
        skipped++;
        continue;
      }
      list.unshift({ path: raw, name: path.basename(raw), addedAt: Date.now() });
      added++;
    }
    if (!added) return { ok: true, added: 0, skipped };
    const r = save(list);
    return { ok: r.ok, added, skipped, error: r.error };
  }

  function remove(p) {
    const key = String(p || "").toLowerCase();
    const list = load().filter((x) => x.path.toLowerCase() !== key);
    const r = save(list);
    return { ok: r.ok, error: r.error };
  }

  function clear() {
    const r = save([]);
    return { ok: r.ok, error: r.error };
  }

  /** 清掉已经不存在的路径（界面提供「清理失效」） */
  function prune() {
    const before = load().length;
    const list = load().filter((x) => exists(x.path));
    const r = save(list);
    return { ok: r.ok, removed: before - list.length, error: r.error };
  }

  function get(p) {
    const key = String(p || "").toLowerCase();
    return load().find((x) => x.path.toLowerCase() === key) || null;
  }

  return { list, add, remove, clear, prune, get, MAX };
}

module.exports = { createShelf, MAX };
