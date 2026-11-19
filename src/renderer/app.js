window.addEventListener("error", (e) => {
  console.log(`[app] ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
const listEl = document.getElementById("list");
const tipEl = document.getElementById("tip");

let plugins = [];
let activeId = null;
let tipTimer = null;

function tip(msg, isErr) {
  tipEl.textContent = msg || "";
  tipEl.style.color = isErr ? "#E24B4A" : "";
  clearTimeout(tipTimer);
  if (msg) tipTimer = setTimeout(() => (tipEl.textContent = ""), 2600);
}

function render(list) {
  plugins = list;
  listEl.innerHTML = "";

  if (!list.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = "<b>还没有程序</b><span>点下面「添加文件」选一个文件，<br>会自动认出该用哪个程序打开</span>";
    listEl.appendChild(e);
    return;
  }

  list.forEach((p) => {
    const row = document.createElement("div");
    row.className = "item" + (p.exeOk ? "" : " missing") + (p.id === activeId ? " active" : "");
    row.dataset.id = p.id;
    row.title = `${p.name}${p.hotkey ? "  " + p.hotkey : ""}\n点这一行：显示 / 收起\n点胶囊：启动 / 结束\n右键：图标 / 删除`;

    const iconHtml = p.icon
      ? `<img class="ico" src="${p.icon}" alt="">`
      : `<span class="ico ph" style="background:${p.color}">${p.short}</span>`;

    const statusText = !p.exeOk
      ? "找不到程序"
      : p.running
        ? "运行中"
        : "未启动";

    row.innerHTML = `
      ${iconHtml}
      <span class="meta">
        <span class="nm">${p.name}</span>
        <span class="st">${statusText}</span>
      </span>
      <span class="switch${p.running ? " on" : ""}" role="switch" aria-checked="${p.running}"></span>
    `;

    // 点整行：显示 / 收起界面
    row.addEventListener("click", async (e) => {
      if (e.target.closest(".switch")) return;
      if (justDragged()) return;        // 刚拖完，这一下不算点击
      // 点行只做「收 / 放」，是最频繁的操作，不能每次都整表重刷。
      // 整表重刷会重算所有条目的图标和进程状态，条目一多就卡。
      // 这里只改这一行的样式，其它行保持不动。
      const r = await window.wb.activate(p.id);
      if (r.silent) {
        // 没在运行：点这一行不作声，启动请用胶囊开关
        return;
      }
      if (!r.ok) {
        tip(r.error || "操作失败", true);
        return;
      }

      const isDown = r.mode === "minimize" || r.mode === "hide";
      activeId = isDown ? null : p.id;
      row.classList.toggle("active", !isDown);

      // 只改本行，不动整表
      const rowSt = row.querySelector(".st");
      if (rowSt) rowSt.textContent = isDown ? (r.mode === "hide" ? "已收起" : "已最小化") : "当前";

      if (r.mode === "minimize") tip(`已最小化 ${p.name}`);
      else if (r.mode === "hide") tip(`已收起 ${p.name}`);
      else if (r.focused === false) tip(`已还原 ${p.name}，但没能抢到前台`, true);
      else tip(`已置顶 ${p.name}`);

      // 让其它行的高亮跟着让位（不重刷数据，只改 class）
      listEl.querySelectorAll(".item.active").forEach((el) => {
        if (el !== row) el.classList.remove("active");
      });

      // 很晚才做一次真实同步，兜住外部变化，不影响手感
      setTimeout(refresh, 2500);
    });

    // 右键：弹出菜单
    // 用 contextmenu 和 mousedown(button=2) 两条路都接上——
    // 无边框 + 永不激活的窗口在部分环境下 contextmenu 不一定派发，mousedown 一定到。
    const onRight = (e) => {
      e.preventDefault();
      openRowMenu(p, e.clientX, e.clientY);
    };
    row.addEventListener("contextmenu", onRight);
    row.addEventListener("mousedown", (e) => {
      if (e.button === 2) onRight(e);
    });
    row.addEventListener("mouseup", (e) => {
      if (e.button === 2) e.preventDefault();
    });

    // 点胶囊：启动 / 结束
    // 关键：点击瞬间就切换视觉状态，不要等后端返回。
    // 程序启动/关闭动辄一两秒，等结果再变会让人以为没点上。
    // 只有真正失败时才回退。
    const sw = row.querySelector(".switch");
    sw.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (sw.classList.contains("busy")) return;

      const wasRunning = sw.classList.contains("on");
      const wantRunning = !wasRunning;

      // 1) 立刻反馈：切状态 + 加 loading 动效
      sw.classList.toggle("on", wantRunning);
      sw.setAttribute("aria-checked", String(wantRunning));
      sw.classList.add("busy");
      row.classList.toggle("pending", wantRunning);
      const st = row.querySelector(".st");
      const prevStatus = st ? st.textContent : "";
      if (st) st.textContent = wantRunning ? "启动中" : "关闭中";
      tip(wantRunning ? `正在启动 ${p.name}…` : `正在结束 ${p.name}…`);

      let r;
      try {
        r = wantRunning ? await window.wb.launch(p.id) : await window.wb.quit(p.id);
      } catch (err) {
        r = { ok: false, error: (err && err.message) || "操作失败" };
      }

      sw.classList.remove("busy");
      row.classList.remove("pending");

      if (!r || !r.ok) {
        // 2) 失败才回退到原状态
        sw.classList.toggle("on", wasRunning);
        sw.setAttribute("aria-checked", String(wasRunning));
        if (st) st.textContent = prevStatus;
        tip((r && (r.error || r.msg)) || "操作失败", true);
        return;
      }

      tip((r && r.msg) || (wantRunning ? `已启动 ${p.name}` : `已关闭 ${p.name}`));
      // 3) 稍后跟一次真实状态，兜底外部变化（用户手动关了之类）
      setTimeout(refresh, 1200);
    });

    // 按住上下拖 = 换位置。横向基本不动，所以只看 Y。
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".switch")) return;
      beginDrag(e, row);
    });

    listEl.appendChild(row);
  });
}

// ---------- 拖动换位 ----------
let lastDragEnd = 0;
const justDragged = () => Date.now() - lastDragEnd < 320;

function beginDrag(e, row) {
  const startY = e.clientY;
  const rect = row.getBoundingClientRect();
  let started = false;
  let mark = null;

  // 抓住指针：这样鼠标滑出窗口边缘也不会断，松手照样能收到
  try {
    row.setPointerCapture(e.pointerId);
  } catch {}

  const onMove = (ev) => {
    if (!started) {
      // 动了几像素才算拖，否则单击会被吃掉
      if (Math.abs(ev.clientY - startY) < 5) return;
      started = true;

      mark = document.createElement("div");
      mark.className = "dropmark";
      mark.style.height = rect.height + "px";
      listEl.insertBefore(mark, row);

      row.classList.add("dragging");
      Object.assign(row.style, {
        position: "fixed",
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        zIndex: "50",
      });
    }

    row.style.top = rect.top + (ev.clientY - startY) + "px";

    // 指针落在谁的上班部分，就插到谁前面
    const others = [...listEl.querySelectorAll(".item:not(.dragging)")];
    let target = null;
    for (const r of others) {
      const b = r.getBoundingClientRect();
      if (ev.clientY < b.top + b.height / 2) {
        target = r;
        break;
      }
    }
    if (target) listEl.insertBefore(mark, target);
    else listEl.appendChild(mark);
  };

  const onUp = async () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!started) return;
    lastDragEnd = Date.now();

    row.classList.remove("dragging");
    row.removeAttribute("style");
    listEl.insertBefore(row, mark);
    mark.remove();

    const ids = [...listEl.querySelectorAll(".item")].map((r) => r.dataset.id);
    const r = await window.wb.reorder(ids);
    if (!r.ok) {
      tip(r.error || "顺序没保存", true);
      setTimeout(refresh, 200);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function refresh() {
  try {
    const list = await window.wb.list();
    render(list);
    return list;
  } catch (e) {
    tip("加载失败：" + ((e && e.message) || e), true);
  }
}

window.wb.onHotkey((id) => {
  // 主进程已经执行过 activate 了，这里只刷新高亮，不要再调一次，
  // 否则会连着切换两次（开了又收）。
  activeId = id;
  setTimeout(refresh, 600);
});

window.wb.onState((d) => {
  if (d && d.msg) tip(d.msg);
});

// 后台补齐图标后刷新一次，避免要等到 12 秒轮询才出现
window.wb.onIconsHealed(() => refresh());

refresh();
setInterval(refresh, 12000);

// ---------- 拖动 ----------
// 用指针捕获自己算位移，不依赖 -webkit-app-region：
// 窗口带 WS_EX_NOACTIVATE，系统拖动不可靠
const railEl = document.querySelector(".rail");
let drag = null;

railEl.addEventListener("pointerdown", async (e) => {
  // 告诉主进程"我刚被点了"，避免自动隐藏把这次交互误判成点了别的窗口
  window.wb.touch();
  if (e.button !== 0) return;
  // 按钮上不做拖动：setPointerCapture 会把随后的 click 也劫持到 rail，按钮就点不动了
  if (e.target.closest(".item, .hbtn, .add, .rmenu, .settings, .shelf")) return;
  // 锁了位置就拖不动，提示一次（两秒内不重复提示，免得连点刷屏）
  const st = await window.wb.getSettings();
  if (st && st.posLocked) {
    if (Date.now() - lastLockTip > 2000) {
      lastLockTip = Date.now();
      tip("位置已锁定。右键托盘或设置里可以解锁");
    }
    return;
  }
  const [wx, wy] = await window.wb.getPos();
  drag = { id: e.pointerId, mx: e.screenX, my: e.screenY, wx, wy };
  try { railEl.setPointerCapture(e.pointerId); } catch {}
  document.body.classList.add("dragging");
});

railEl.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  window.wb.setPos(drag.wx + (e.screenX - drag.mx), drag.wy + (e.screenY - drag.my));
});

const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  try { railEl.releasePointerCapture(e.pointerId); } catch {}
  drag = null;
  document.body.classList.remove("dragging");
};
railEl.addEventListener("pointerup", endDrag);
railEl.addEventListener("pointercancel", endDrag);

// 点空白处关闭文件浮层
// ---------- 右键菜单 ----------

let rowMenu = null;
let lastRcAt = 0;   // 上次弹菜单的时间，用来去重

function closeRowMenu() {
  if (rowMenu) {
    rowMenu.remove();
    rowMenu = null;
  }
}

function openRowMenu(p, clientX, clientY) {
  // 同一秒内的重复触发（原生 contextmenu + 主进程转发）只弹一次
  if (Date.now() - lastRcAt < 400) return;
  lastRcAt = Date.now();

  closeRowMenu();

  const menu = document.createElement("div");
  menu.className = "rmenu";

  const mk = (label, cls, fn) => {
    const it = document.createElement("div");
    it.className = "rmi" + (cls ? " " + cls : "");
    it.textContent = label;
    it.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeRowMenu();
      await fn();
    });
    menu.appendChild(it);
    return it;
  };

  mk("重建图标", "", async () => {
    const r = await window.wb.rebuildIcon(p.id);
    tip(r.ok ? `已重建 ${p.name} 的图标` : r.error || "重建失败", !r.ok);
    setTimeout(refresh, 600);
  });

  menu.appendChild(Object.assign(document.createElement("div"), { className: "rsep" }));
  mk("删除", "danger", async () => {
    const r = await window.wb.removeProgram(p.id);
    tip(r.ok ? `已删除 ${r.name}` : r.error || "删除失败", !r.ok);
    setTimeout(refresh, 600);
  });

  document.querySelector(".rail").appendChild(menu);

  // 定位到光标处，并保证不超出窗口
  const railR = document.querySelector(".rail").getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = clientX - railR.left;
  let top = clientY - railR.top;
  if (left + mw > railR.width - 6) left = railR.width - mw - 6;
  if (left < 6) left = 6;
  if (top + mh > railR.height - 6) top = railR.height - mh - 6;
  if (top < 30) top = 30;
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  rowMenu = menu;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".rmenu")) closeRowMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRowMenu();
  }
});

// ---------- 置顶 ----------
const pinBtn = document.getElementById("pin");
function paintPin(on) {
  pinBtn.classList.toggle("on", on);
  pinBtn.title = on ? "已置顶 · 点击取消置顶" : "未置顶 · 点击置顶";
}
pinBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const on = await window.wb.pin();
  paintPin(on);
  tip(on ? "已置顶" : "已取消置顶");
});
window.wb.isPinned().then(paintPin);

// ---------- 关闭 ----------
// 点 × 只收进托盘，不退出进程。真要退出在托盘右键里。
document.getElementById("close").addEventListener("click", async (e) => {
  e.stopPropagation();
  await window.wb.toTray();
});

// ---------- 设置 ----------

const gearBtn = document.getElementById("gear");
const settingsEl = document.getElementById("settings");
const hkBtn = document.getElementById("hkBtn");
const hkHint = document.getElementById("hkHint");

let settingsOpen = false;
let recording = false;

function prettyAccel(acc) {
  if (!acc) return "未设置";
  return acc
    .replace(/\bCtrl\b/g, "Ctrl")
    .replace(/\bAlt\b/g, "Alt")
    .replace(/\bShift\b/g, "Shift")
    .replace(/\bSuper\b/g, "Win")
    .replace(/\+/g, " + ");
}

async function paintHotkey() {
  const s = await window.wb.getSettings();
  const acc = s.toggleHotkey || "";
  hkBtn.textContent = prettyAccel(acc);
  hkBtn.classList.toggle("unset", !acc);
}

// 贴边自动收起开关
const edgeBtn = document.getElementById("edgeBtn");
async function paintEdgeHide() {
  try {
    const s = await window.wb.getSettings();
    const on = s.edgeHide !== false;
    edgeBtn.textContent = on ? "开" : "关";
    edgeBtn.classList.toggle("unset", !on);
  } catch {}
}
edgeBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const s = await window.wb.getSettings();
  const next = s.edgeHide === false; // 当前关着 → 打开
  const r = await window.wb.setEdgeHide(next);
  await paintEdgeHide();
  tip(r && r.ok ? (next ? "已开启贴边自动收起" : "已关闭贴边自动收起") : "设置失败", !(r && r.ok));
});

// 锁定位置
const lockBtn = document.getElementById("lockBtn");
async function paintLock() {
  try {
    const s = await window.wb.getSettings();
    lockBtn.textContent = s.posLocked ? "开" : "关";
    lockBtn.classList.toggle("unset", !s.posLocked);
  } catch {}
}
lockBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const s = await window.wb.getSettings();
  const next = !s.posLocked;
  const r = await window.wb.setPosLocked(next);
  await paintLock();
  tip(r && r.ok ? (next ? "位置已锁定，拖动不会动" : "位置已解锁") : "设置失败", !(r && r.ok));
});

// 开机自启：开发模式下没有意义，主进程会拒绝，这里直接隐藏那一行
const autoBtn = document.getElementById("autoBtn");
const autoRow = document.getElementById("autostartRow");
async function paintAutoStart() {
  try {
    const s = await window.wb.getSettings();
    if (!s.packaged) {
      autoRow.hidden = true;
      return;
    }
    autoRow.hidden = false;
    autoBtn.textContent = s.openAtLogin ? "开" : "关";
    autoBtn.classList.toggle("unset", !s.openAtLogin);
  } catch {}
}
autoBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const s = await window.wb.getSettings();
  const next = !s.openAtLogin;
  const r = await window.wb.setAutoStart(next);
  await paintAutoStart();
  tip(
    r && r.ok ? (next ? "已设为开机自启" : "已取消开机自启") : (r && r.error) || "设置失败",
    !(r && r.ok)
  );
});

function setHint(msg, isErr) {
  hkHint.innerHTML =
    msg ||
    "点上面按钮，然后按下组合键。<br>必须含 Ctrl / Alt / Shift；按同一个键可以再收起。";
  hkHint.classList.toggle("err", !!isErr);
}

function toggleSettings(force) {
  const next = typeof force === "boolean" ? force : !settingsOpen;
  settingsOpen = next;
  settingsEl.hidden = !next;
  gearBtn.classList.toggle("active", next);
  if (next) {
    paintHotkey();
    paintEdgeHide();
    paintLock();
    paintAutoStart();
    setHint("");
  } else if (recording) {
    stopRecording();
  }
}

gearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});

// 录制中点到别处就取消，免得一直在等键盘
document.addEventListener("click", (e) => {
  if (recording && !e.target.closest(".settings")) {
    stopRecording();
    setHint("");
  }
});

document.getElementById("settingsClose").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings(false);
});

// 把键盘事件翻译成 Electron 的 accelerator
function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  const k = e.key;
  // 只按下修饰键，等真正的键
  if (["Control", "Alt", "Shift", "Meta"].includes(k)) return null;

  let key = null;
  if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
  else {
    const map = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Enter: "Return",
      Escape: "Escape",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Insert: "Insert",
      "`": "`",
      "-": "-",
      "=": "=",
      "[": "[",
      "]": "]",
      "\\": "\\",
      ";": ";",
      "'": "'",
      ",": ",",
      ".": ".",
      "/": "/",
    };
    key = map[k] || null;
  }
  if (!key) return null;
  if (!mods.length) return null;   // 不带修饰键会抢走正常输入
  return [...mods, key].join("+");
}

async function startRecording() {
  recording = true;
  hkBtn.classList.add("recording");
  hkBtn.classList.remove("unset");
  hkBtn.textContent = "按下组合键…";
  setHint("");
  await window.wb.beginCapture();   // 临时解除"永不激活"，否则收不到键盘
}

async function stopRecording() {
  recording = false;
  hkBtn.classList.remove("recording");
  // 取消录制时也要把密钥重新挂上（录制期间是注销状态）
  const end = await window.wb.endCapture();
  if (end && end.error) setHint(end.error, true);
  paintHotkey();
}

hkBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (recording) {
    await stopRecording();
    return;
  }
  await startRecording();
});

window.addEventListener("keydown", async (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    await stopRecording();
    setHint("");
    return;
  }
  if (e.key === "Backspace") {
    hkBtn.classList.remove("recording");
    recording = false;
    const r = await window.wb.setHotkey("");
    await window.wb.endCapture();
    paintHotkey();
    setHint(r.ok ? "已清除。" : r.error || "清除失败", !r.ok);
    return;
  }

  const acc = accelFromEvent(e);
  if (!acc) {
    setHint("这个键不行——必须带 Ctrl / Alt / Shift 之一，而且要有个主键。", true);
    return;
  }

  hkBtn.textContent = prettyAccel(acc);
  const r = await window.wb.setHotkey(acc);
  recording = false;
  hkBtn.classList.remove("recording");
  // 注册在 endCapture 里真正生效（录制期间全局快捷键是注销状态），
  // 所以要拿它的返回判断到底有没有挂上。
  const end = await window.wb.endCapture();

  if (!r.ok) {
    setHint(r.error || "设置失败", true);
  } else if (end && end.error) {
    setHint(end.error, true);
  } else {
    setHint(`已设为 ${prettyAccel(acc)}。按它可以把悬浮台唤出 / 收起。`);
  }
  paintHotkey();
});

// ---------- 添加文件 ----------
// 把文件直接拖进悬浮台
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const p = window.wb.getPathForFile(f);
  if (!p) {
    tip("读不到这个文件的路径", true);
    return;
  }
  tip(`正在添加 ${f.name}…`);
  const r = await window.wb.addFile(p);
  tip(r.ok ? `已添加 ${f.name} → ${r.name}` : r.error || "添加失败", !r.ok);
  setTimeout(refresh, 500);
});

const addBtn = document.getElementById("add");

addBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  addBtn.disabled = true;
  tip("选一个文件…");
  try {
    const r = await window.wb.pickFile();
    if (!r.ok) {
      tip(r.canceled ? "" : r.error || "没选中文件", !r.canceled);
      return;
    }
    const a = await window.wb.addFile(r.path);
    if (!a.ok) {
      tip(a.error || "添加失败", true);
      return;
    }
    tip(`已添加 ${a.file} → ${a.name}`);
    setTimeout(refresh, 500);
  } catch (err) {
    tip("出错了：" + ((err && err.message) || err), true);
  } finally {
    addBtn.disabled = false;
  }
});


// ---------- 运行环境提示（Python 缺失等） ----------

const envWarn = document.getElementById("envwarn");
const envWarnText = document.getElementById("envwarn-text");
const envWarnHint = document.getElementById("envwarn-hint");
const envDismissKey = "pane.envwarn.dismissed";

function showEnvWarn(s) {
  if (!envWarn) return;
  if (!s || s.ok !== false) {
    envWarn.hidden = true;
    return;
  }
  // 用户手动关掉后，同一台机器不再重复打扰（重新检测时强制显示）
  if (sessionStorage.getItem(envDismissKey) === "1") {
    envWarn.hidden = true;
    return;
  }
  envWarnText.textContent = s.message || "部分功能不可用";
  envWarnHint.textContent = s.hint || "";
  envWarn.hidden = false;
}

async function refreshEnv() {
  try {
    const s = await window.wb.envStatus();
    showEnvWarn(s);
  } catch {}
}

document.getElementById("envreprobe")?.addEventListener("click", async () => {
  sessionStorage.removeItem(envDismissKey);
  try {
    const s = await window.wb.envReprobe();
    showEnvWarn(s);
    if (s && s.ok) envWarn.hidden = true;
  } catch {}
});

document.getElementById("envdismiss")?.addEventListener("click", () => {
  sessionStorage.setItem(envDismissKey, "1");
  if (envWarn) envWarn.hidden = true;
});

// 启动后延迟一点探测，别和首屏渲染抢
setTimeout(refreshEnv, 1500);

// ---------- 文件中转架 ----------
// 只记路径，不复制文件：拖进来暂存，换个窗口再拖出去

const shelfEl = document.getElementById("shelf");
const shelfHead = document.getElementById("shelfHead");
const shelfBody = document.getElementById("shelfBody");
const shelfItems = document.getElementById("shelfItems");
const shelfCount = document.getElementById("shelfCount");
const shelfEmpty = document.getElementById("shelfEmpty");
let shelfOpened = false;

function extBadge(it) {
  const e = (it.ext || "").toUpperCase();
  return e ? e.slice(0, 4) : "文件";
}

function renderShelf(list) {
  shelfCount.textContent = String(list.length || 0);
  shelfItems.innerHTML = "";
  shelfEmpty.hidden = (list || []).length > 0;

  for (const it of list) {
    const row = document.createElement("div");
    row.className = "sitem" + (it.exists ? "" : " gone");
    row.title = it.path + (it.exists ? "" : "\n文件已不在这个位置");
    row.innerHTML = `
      <span class="shandle" title="按住拖出去">⣿</span>
      <span class="sext">${extBadge(it)}</span>
      <span class="sname">${it.name}</span>
      <span class="sx" title="从中转架移除">×</span>
    `;

    // 点这一行：打开文件
    row.addEventListener("click", async (e) => {
      if (e.target.closest(".sx") || e.target.closest(".shandle")) return;
      if (!it.exists) {
        tip("这个文件已经不在了", true);
        return;
      }
      const r = await window.wb.shelfOpen(it.path);
      if (!r.ok) tip(r.error || "打不开", true);
    });

    // 握把：按住就能拖到别的窗口
    row.querySelector(".shandle").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!it.exists) {
        tip("这个文件已经不在了", true);
        return;
      }
      window.wb.shelfDrag(it.path);
    });

    row.querySelector(".sx").addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.wb.shelfRemove(it.path);
      refreshShelf();
    });

    // 右键：复制路径
    row.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await window.wb.shelfCopyPath(it.path);
      tip("已复制路径");
    });

    shelfItems.appendChild(row);
  }
}

async function refreshShelf() {
  try {
    renderShelf(await window.wb.shelfList());
  } catch {}
}

function openShelf(on) {
  shelfOpened = typeof on === "boolean" ? on : !shelfOpened;
  shelfBody.hidden = !shelfOpened;
  shelfHead.classList.toggle("open", shelfOpened);
  if (shelfOpened) refreshShelf();
}

shelfHead.addEventListener("click", (e) => {
  e.stopPropagation();
  openShelf();
});

document.getElementById("shelfPrune").addEventListener("click", async (e) => {
  e.stopPropagation();
  const r = await window.wb.shelfPrune();
  tip(r.removed ? `清理了 ${r.removed} 个失效条目` : "没有失效条目");
  refreshShelf();
});

document.getElementById("shelfClear").addEventListener("click", async (e) => {
  e.stopPropagation();
  await window.wb.shelfClear();
  refreshShelf();
  tip("中转架已清空");
});

// 拖入：只在 shelf 区域接管，别影响「拖文件到列表 = 添加程序」的老行为
async function dropToShelf(e) {
  const paths = [];
  for (const f of e.dataTransfer.files || []) {
    const p = window.wb.getPathForFile(f);
    if (p) paths.push(p);
  }
  if (!paths.length) return;
  const r = await window.wb.shelfAdd(paths);
  if (!r.ok) {
    tip(r.error || "暂存失败", true);
    return;
  }
  if (!shelfOpened) openShelf(true);
  refreshShelf();
  tip(`已暂存 ${r.added} 个${r.skipped ? `，跳过 ${r.skipped} 个重复` : ""}`);
}

for (const el of [shelfEl, shelfHead, shelfBody]) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    shelfEl.classList.add("over");
  });
  el.addEventListener("dragleave", (e) => {
    if (!shelfEl.contains(e.relatedTarget)) shelfEl.classList.remove("over");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    shelfEl.classList.remove("over");
    await dropToShelf(e);
  });
}

refreshShelf();