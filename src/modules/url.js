/**
 * URL 归一化 —— 用户在内置浏览器地址栏里输入的东西可能是网址、本地路径、
 * 也可能是裸主机名，这里统一成能直接 load 的 URL。
 *
 * 纯函数，从 main.js 抽出来便于单测。
 */

/**
 * @param {string} raw 用户输入
 * @returns {string|null} 可 load 的 URL；无法识别返回 null
 */
function normalizeUrl(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // 已经带协议的直接用
  if (/^(https?|file|about|data):/i.test(s)) return s;

  // 本地路径：C:\xxx 或 //server/share
  if (/^[a-z]:[\\/]/i.test(s) || s.startsWith("\\\\")) {
    return "file:///" + s.replace(/\\/g, "/");
  }

  // 本机地址补 http
  if (/^localhost(:\d+)?/i.test(s) || /^127\.0\.0\.1(:\d+)?/.test(s)) return "http://" + s;

  // 看着像域名就补 http
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s)) return "http://" + s;

  // 其它当成主机名硬拼 http，让它自己报错 —— 比默默跳回首页好懂
  if (/^[\w-]+(:\d+)?(\/.*)?$/.test(s)) return "http://" + s;

  return null;
}

module.exports = { normalizeUrl };