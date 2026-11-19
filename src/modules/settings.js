/**
 * 设置项的读写 —— 快捷键、贴边收起、锁定位置、自动更新几项。
 *
 * 存成 JSON 放在数据目录，损坏时退回默认值而不是崩。
 */

const fs = require("fs");
const { writeFileSafe, readJsonSafe } = require("./safefs");

const DEFAULTS = { toggleHotkey: "Ctrl+F9", edgeHide: true, posLocked: false, autoUpdate: true };

/**
 * @param {object} deps
 * @param {string} deps.settingsFile  设置文件路径
 */
function createSettings(deps) {
  const { settingsFile: SETTINGS_FILE } = deps;
  let cache = null;

  function load() {
    if (cache) return cache;
    // 解析失败时坏文件会被改名保留，这里退回默认值继续运行
    const r = readJsonSafe(SETTINGS_FILE);
    cache = r.ok ? Object.assign({}, DEFAULTS, r.data) : Object.assign({}, DEFAULTS);
    return cache;
  }

  function save(patch) {
    cache = Object.assign({}, load(), patch);
    try {
      writeFileSafe(SETTINGS_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
      console.error("[settings] 保存失败:", e.message);
      return { ok: false, error: e.message };
    }
    return { ok: true, settings: cache };
  }

  return { load, save, get: () => load() };
}

module.exports = { createSettings, SETTINGS_DEFAULTS: DEFAULTS };
