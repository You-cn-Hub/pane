/**
 * .lnk 快捷方式解析 —— 纯 JS 读二进制，不依赖 COM 与 Python。
 *
 * 为什么不用 WScript.Shell：
 *   这台机器上 COM 实例化会被安全策略拦截（New-Object -ComObject 直接失败），
 *   PowerShell 方案在本地能跑、在目标机器上不一定能。
 *   .lnk 是公开的二进制格式（MS-SHLLINK），自己读反而更稳。
 *
 * 解析范围：
 *   只取我们真正需要的四个字段 —— 目标路径、参数、工作目录、图标位置。
 *   不做完整格式实现，遇到不认识的段就跳过。
 */

const fs = require("fs");

// LinkFlags（MS-SHLLINK 2.1）
const HAS_LINK_TARGET_ID_LIST = 0x00000001;
const HAS_LINK_INFO = 0x00000002;
const HAS_NAME = 0x00000004;
const HAS_RELATIVE_PATH = 0x00000008;
const HAS_WORKING_DIR = 0x00000010;
const HAS_ARGUMENTS = 0x00000020;
const HAS_ICON_LOCATION = 0x00000040;
const IS_UNICODE = 0x00000080;

/**
 * 读一个 CountedString（2 字节长度 + 字符）
 * @returns {{value: string, next: number}}
 */
function readString(buf, off, unicode) {
  if (off + 2 > buf.length) return { value: "", next: buf.length };
  const count = buf.readUInt16LE(off);
  const start = off + 2;
  if (unicode) {
    const bytes = count * 2;
    if (start + bytes > buf.length) return { value: "", next: buf.length };
    return { value: buf.toString("utf16le", start, start + bytes), next: start + bytes };
  }
  if (start + count > buf.length) return { value: "", next: buf.length };
  // ANSI 分支：按 latin1 读，中文会失真，但主路径通常走 Unicode
  return { value: buf.toString("latin1", start, start + count), next: start + count };
}

/** 读 LinkInfo 结构里的本地路径 */
function readLinkInfoPath(buf, start) {
  try {
    const infoSize = buf.readUInt32LE(start);
    if (infoSize < 0x1C || start + infoSize > buf.length) return { value: "", next: start + infoSize };
    const headerSize = buf.readUInt32LE(start + 4);
    const flags = buf.readUInt32LE(start + 8);
    const volumeOffset = buf.readUInt32LE(start + 12);
    const localPathOffset = buf.readUInt32LE(start + 16);
    const next = start + infoSize;
    if (!localPathOffset) return { value: "", next };
    const p = start + localPathOffset;
    if (p >= buf.length) return { value: "", next };
    // 本地路径以 NUL 结尾的 ANSI 串（或 Unicode，看 volume 段标志）
    let end = p;
    while (end + 1 < buf.length && buf.readUInt16LE(end) !== 0) end += 2;
    if (end > p) {
      const wide = buf.toString("utf16le", p, end);
      // 明显是正常路径才用
      if (/^[\w\\:.\-\s\u4e00-\u9fa5]+$/.test(wide)) return { value: wide, next };
    }
    // 退回按 ANSI 读
    let e2 = p;
    while (e2 < buf.length && buf[e2] !== 0) e2++;
    return { value: buf.toString("latin1", p, e2), next };
  } catch {
    return { value: "", next: start + 0x1C };
  }
}

/**
 * 从 LinkTargetIDList 里还原路径。
 *
 * 有些快捷方式没有 LinkInfo 段（flags 里 HasLinkInfo=false），
 * 目标路径只存在 IDList 里，必须靠这段兜底。
 *
 * 结构：一串 ItemID，每个前 2 字节是长度；
 *   0x2F = 盘符根（后跟 ASCII "E:\"）
 *   0x31 = 目录（路径文本在固定偏移后，NUL 结尾）
 *   0x32 = 文件（同上）
 * 以长度 0 结束。
 */
function parseIdList(buf, off, size) {
  const end = Math.min(off + size, buf.length);
  const parts = [];
  let p = off;
  while (p + 2 <= end) {
    const sz = buf.readUInt16LE(p);
    if (sz === 0) break;
    if (p + sz > buf.length) break;
    const type = sz >= 3 ? buf[p + 2] : -1;

    if (type === 0x2f && sz >= 5) {
      // 盘符根：跳过 2 字节长度 + 1 字节类型 = 3，后面直接是 ASCII 路径
      let e = p + 3;
      while (e < p + sz && buf[e] !== 0) e++;
      const root = buf.toString("latin1", p + 3, e);
      if (root) parts.push(root);
    } else if ((type === 0x31 || type === 0x32) && sz > 16) {
      // 目录/文件项：名称从偏移 14 开始，NUL 结尾。
      // 里面可能嵌一小段 UTF-16 原文（中文名），所以 ASCII 拿不到时再按 UTF-16 试。
      let name = "";
      let e = p + 14;
      while (e < p + sz && buf[e] !== 0) e++;
      if (e > p + 14) {
        const ascii = buf.toString("latin1", p + 14, e);
        if (/^[\x20-\x7E]+$/.test(ascii)) {
          name = ascii;
        } else {
          // 尾部一段能被解释成 UTF-16 的文字才是真名
          const tail = buf.slice(p + 14, e);
          let best = "";
          for (let k = 0; k + 4 <= tail.length; k += 2) {
            const s = tail.toString("utf16le", k, tail.length).replace(/\u0000+$/, "");
            if (s && /^[\u4e00-\u9fa5\w\-.]+$/.test(s) && s.length > best.length) best = s;
          }
          name = best;
        }
      }
      if (name) parts.push(name);
    }
    p += sz;
  }

  if (!parts.length) return "";

  // 第一段通常是盘符根（E:\），后面依次是目录与文件名
  let out = parts.join("\\");
  out = out.replace(/\\\\/g, "\\");
  // 盘符根已带反斜杠，避免 E:\\Data
  out = out.replace(/^([A-Za-z]:)\\+/, "$1\\");
  return out;
}

/**
 * 解析 .lnk 文件。
 * @param {string} file 绝对路径
 * @returns {{ok:true,target:string,args:string,workdir:string,icon:string|null}|{ok:false,error:string}}
 */
function parseLnk(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, error: "读不到文件：" + e.message };
  }
  if (buf.length < 0x4C) return { ok: false, error: "文件太小，不是有效快捷方式" };

  // Header：前 4 字节是 HeaderSize，必须 0x4C；后面是 CLSID
  const headerSize = buf.readUInt32LE(0);
  if (headerSize !== 0x4C) return { ok: false, error: "不是 .lnk 文件（头长度不符）" };

  const flags = buf.readUInt32LE(0x14);
  const unicode = (flags & IS_UNICODE) !== 0;

  let off = 0x4C;

  // 1. LinkTargetIDList —— 没有 LinkInfo 时这是唯一的路径来源
  let idListPath = "";
  if (flags & HAS_LINK_TARGET_ID_LIST) {
    if (off + 2 > buf.length) return { ok: false, error: "结构截断" };
    const idListSize = buf.readUInt16LE(off);
    idListPath = parseIdList(buf, off + 2, idListSize);
    off += 2 + idListSize;
  }

  // 2. LinkInfo
  let target = "";
  if (flags & HAS_LINK_INFO) {
    if (off + 4 > buf.length) return { ok: false, error: "结构截断" };
    const r = readLinkInfoPath(buf, off);
    target = r.value;
    off = r.next;
  }

  // 3. StringData：Name, RelativePath, WorkingDir, Arguments, IconLocation
  let name = "";
  let relativePath = "";
  let workdir = "";
  let args = "";
  let iconLoc = "";

  const skipHints = (skip, hint) => {
    if (flags & skip) {
      const r = readString(buf, off, unicode);
      off = r.next;
      return r.value;
    }
    return "";
  };

  name = skipHints(HAS_NAME, "name");
  relativePath = skipHints(HAS_RELATIVE_PATH, "rel");
  workdir = skipHints(HAS_WORKING_DIR, "wd");
  args = skipHints(HAS_ARGUMENTS, "args");
  iconLoc = skipHints(HAS_ICON_LOCATION, "icon");

  // 目标路径优先级：LinkInfo 绝对路径 > IDList 还原 > 相对路径
  if (!target && idListPath) target = idListPath;
  if (!target && relativePath) target = relativePath;

  if (!target) return { ok: false, error: "解析不出目标路径" };

  // IconLocation 形如 "C:\\path\\app.exe,0"，取逗号前
  const icon = iconLoc ? iconLoc.split(",")[0].trim().replace(/^"|"$/g, "") : null;

  return {
    ok: true,
    target,
    args: args || "",
    workdir: workdir || "",
    icon,
    name: name || "",
  };
}

module.exports = { parseLnk };