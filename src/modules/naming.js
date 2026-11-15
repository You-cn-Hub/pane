/**
 * 程序条目的标识与配色 —— 纯函数，不碰文件系统、不依赖 Electron。
 *
 * 从 main.js 抽出来，目的是让这两块逻辑能单独测试。
 * 之前它们埋在 1700 行的 main.js 里，改一行都不知道会不会影响别处。
 */

/** 兜底色板：取不到图标时按名字散列挑一个，保证同一程序颜色稳定 */
const PALETTE = [
  "#5B8DEF",
  "#3FA796",
  "#C0803E",
  "#8A6FD1",
  "#D1605B",
  "#4C9AD1",
  "#7BA05B",
  "#C46BA8",
];

/**
 * 把程序名转成文件名安全的 id。
 * 保留中文（用户看得懂），其他非字母数字一律压成单个连字符。
 * 结果为空时回退成 "app"，避免生成空文件名。
 */
function slugify(name) {
  const s = String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "app";
}

/**
 * 按种子字符串稳定地挑一个颜色。
 * 同一个名字永远得到同一个色，重启也不变。
 */
function pickColor(seed) {
  const str = String(seed == null ? "" : seed);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

module.exports = { slugify, pickColor, PALETTE };