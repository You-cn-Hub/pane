/**
 * 启动器识别与进程名校正。
 *
 * 问题：很多软件的主 exe 只是个启动器（SodaMusicLauncher、Steam、各种 Launcher），
 * 它拉真正的主程序后就自己退出了。
 * 如果按启动器进程名去判断「在不在运行」，永远判断不出来。
 *
 * 做法：
 *   1. 名字里带 launcher / bootstrap / stub 的，一律当作可疑启动器
 *   2. 启动后等一小会儿，看哪个进程还在、且名字和启动器同源
 *   3. 把找到的真实进程名写回配置
 */

/** 名字像不像启动器 */
function looksLikeLauncher(exeName) {
  return /(launcher|bootstrap|stub|updater|update|start|loader)\.exe$/i.test(exeName || "");
}

/** 取两个进程名的「词根」，用来判断是不是同一家软件 */
function rootOf(exeName) {
  return String(exeName || "")
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/(launcher|bootstrap|stub|updater|update|start|loader|helper|service|crashpad|renderer|gpu)$/g, "")
    .replace(/[\s_\-.]/g, "");
}

/**
 * 从当前进程列表里找出「真正的主程序」。
 * @param {string[]} procs 当前可见进程名
 * @param {string} launcherExe 启动器 exe 名
 * @returns {string|null}
 */
function pickRealProcess(procs, launcherExe) {
  const root = rootOf(launcherExe);
  if (!root) return null;
  const cands = procs.filter((p) => {
    const r = rootOf(p);
    if (!r) return false;
    // 词根要能对上：一边包含另一边即可
    return r === root || r.startsWith(root) || root.startsWith(r);
  });
  if (!cands.length) return null;
  // 优先不含 launcher 字样的
  const nonLauncher = cands.filter((p) => !looksLikeLauncher(p));
  const list = nonLauncher.length ? nonLauncher : cands;
  // 同名词有多份时无关紧要，返回第一个（进程名一致）
  return list[0];
}

module.exports = { looksLikeLauncher, rootOf, pickRealProcess };