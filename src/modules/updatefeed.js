/**
 * 更新源解析 —— 纯逻辑：比版本、挑资产、拼镜像地址。
 *
 * 为什么单独一个模块：
 *   这台机器的 github.com 是断的（timeout / ECONNRESET），
 *   electron-updater 直连永远失败，更新功能等于没有。
 *   所以退路是走 api.github.com（通）+ 第三方镜像下载。
 *   这里只做字符串与版本计算，好单测，不碰网络。
 */

/** 版本号比较：a > b 返回 1，相等 0，小于 -1。忽略前缀 v 和非数字尾巴 */
function compareVersion(a, b) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((x) => parseInt(x, 10) || 0);
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

/**
 * 从 GitHub release 的对象里挑出 Windows 安装包。
 * 优先 artifactName 规则的 `Pane-Setup-x.y.z.exe`，其次是任意 .exe。
 * @param {{assets?: Array<{name:string, browser_download_url:string, size:number}>}} release
 */
function pickAsset(release) {
  const list = (release && release.assets) || [];
  const exes = list.filter((a) => a && /\.exe$/i.test(a.name || ""));
  if (!exes.length) return null;
  const setup = exes.find((a) => /^Pane-Setup-.*\.exe$/i.test(a.name));
  return setup || exes[0];
}

/**
 * 把 release 的资产地址换到镜像前缀下。
 * 形如 https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
 * @param {string} mirror 镜像前缀（含结尾斜杠与否都行；空串表示直连）
 * @param {string} url 原始下载地址
 */
function mirrorUrl(mirror, url) {
  const raw = String(url || "");
  if (!mirror) return raw;
  const base = String(mirror).endsWith("/") ? String(mirror) : String(mirror) + "/";
  return base + raw;
}

/** 内置镜像候选：直连放第一个，其余按实测可用性排 */
const MIRRORS = ["", "https://gh-proxy.com/", "https://ghproxy.cfd/", "https://ghfile.geekertao.top/"];

/**
 * 解析一次检查结果，决定「要不要更新」。
 * @param {object} release GitHub API 的 /releases/latest 响应
 * @param {string} current 当前版本
 * @returns {{hasUpdate:boolean, version:string|null, asset:object|null, notes:string}}
 */
function parseRelease(release, current) {
  if (!release || typeof release !== "object") {
    return { hasUpdate: false, version: null, asset: null, notes: "" };
  }
  const tag = String(release.tag_name || release.name || "").trim();
  const version = tag.replace(/^v/i, "");
  if (!version || release.draft || release.prerelease) {
    return { hasUpdate: false, version: version || null, asset: null, notes: "" };
  }
  const asset = pickAsset(release);
  const newer = compareVersion(version, current) > 0;
  return {
    hasUpdate: newer && !!asset,
    version,
    asset,
    notes: String(release.body || "").slice(0, 800),
  };
}

module.exports = { compareVersion, pickAsset, mirrorUrl, parseRelease, MIRRORS };
