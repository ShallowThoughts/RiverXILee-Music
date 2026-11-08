export const ONBOARDING_STEPS = [
  { target: "#control-bar", title: "让歌词跟上你的音乐", text: "先在支持的音乐客户端播放一首歌，无需本地音频。鼠标移到窗口底部，就能找到播放控制和设置。" },
  { page: "sync", target: "#player-source-select", title: "选对正在听的播放器", text: "默认自动选择正在播放的音乐平台。多个客户端同时打开时，可在这里指定歌词跟随谁；普通视频应用不会参与识别。" },
  { page: "layout", target: '[data-settings-section="layout"] .settings-grid', title: "把歌词放在舒服的位置", text: "显示一到五行，字号、行间距和上下左右位置都能调。窗口位置也可以拖动，改好的样式会自动保存。" },
  { page: "appearance", target: '[data-settings-section="appearance"] .settings-grid', title: "选一种属于你的演出", text: "在这里选择本机字体、柔和彩色或纯色高亮，以及歌词动效。字体需要先安装到 Windows。" },
  { page: "sync", target: "#offset-status", title: "提前或延后，只校准这一首", text: "整句歌词偏早或偏晚时，用下方按钮微调；每首歌单独记忆。歌词版本不对，还可以手动选择候选版本。" },
  { target: "#lock-button", title: "想专心时，让鼠标穿过去", text: "" },
  { page: "about", target: "#onboarding-replay-button", title: "随时回来，再看一遍", text: "引导到这里就结束了。以后从「设置 → 关于与帮助 → 新手引导」重新打开；遇到识别或同步问题，可在这里提交反馈。" },
];

// Pick a non-overlapping side first; clamp every candidate to the viewport.
export function tourPlacement(target, card, viewport) {
  const pad = 12, gap = 16;
  const width = Math.min(card.width, viewport.width - pad * 2);
  const height = Math.min(card.height, viewport.height - pad * 2);
  const clamp = (n, max) => Math.max(pad, Math.min(n, Math.max(pad, max - pad)));
  const candidates = [
    [target.left - width - gap, target.top],
    [target.right + gap, target.top],
    [target.left, target.top - height - gap],
    [target.left, target.bottom + gap],
  ].map(([x, y]) => ({ left: clamp(x, viewport.width - width), top: clamp(y, viewport.height - height) }));
  const overlap = ({ left, top }) => Math.max(0, Math.min(left + width, target.right) - Math.max(left, target.left))
    * Math.max(0, Math.min(top + height, target.bottom) - Math.max(top, target.top));
  return candidates.sort((a, b) => overlap(a) - overlap(b))[0];
}

export function clipTourTarget(rect, viewport, container = {}) {
  if (!rect) return null;
  const left = Math.max(0, rect.left, container.left ?? 0);
  const top = Math.max(0, rect.top, container.top ?? 0);
  const right = Math.min(viewport.width, rect.right, container.right ?? viewport.width);
  const bottom = Math.min(viewport.height, rect.bottom, container.bottom ?? viewport.height);
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

export function createOnboarding({ prepare, restore, dismiss, lockDescription }) {
  const root = document.createElement("div");
  root.className = "onboarding";
  root.hidden = true;
  root.innerHTML = `${Array.from({ length: 4 }, () => '<div class="tour-shield" aria-hidden="true"></div>').join("")}<div class="tour-spotlight" aria-hidden="true"></div>
    <section class="tour-card" role="dialog" aria-labelledby="tour-title" aria-describedby="tour-description">
      <div class="tour-copy" aria-live="polite" aria-atomic="true">
        <h2 id="tour-title"></h2><p id="tour-description"></p>
      </div>
      <div class="tour-footer"><span id="tour-progress" role="status" aria-label="引导进度"></span>
        <div class="tour-actions"><button type="button" data-tour="back">上一步</button>
          <button type="button" data-tour="skip">跳过</button><button type="button" data-tour="next">下一步</button></div>
      </div>
    </section>`;
  document.body.append(root);
  const card = root.querySelector(".tour-card"), spot = root.querySelector(".tour-spotlight");
  const shields = [...root.querySelectorAll(".tour-shield")];
  const next = root.querySelector('[data-tour="next"]'), back = root.querySelector('[data-tour="back"]');
  let index = -1, origin = null, frame = 0, target = null;
  const observer = new ResizeObserver(() => schedule());
  function position() {
    frame = 0;
    if (index < 0) return;
    const viewport = { width: innerWidth, height: innerHeight };
    const container = target?.closest(".settings-section")?.getBoundingClientRect();
    const rect = clipTourTarget(target?.getBoundingClientRect(), viewport, container);
    const visible = Boolean(rect);
    spot.hidden = !visible;
    root.classList.toggle("tour-no-target", !visible);
    const anchor = visible ? rect : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2 };
    const left = visible ? Math.max(0, rect.left - 5) : 0;
    const top = visible ? Math.max(0, rect.top - 5) : 0;
    const right = visible ? Math.min(innerWidth, rect.right + 5) : 0;
    const bottom = visible ? Math.min(innerHeight, rect.bottom + 5) : 0;
    const box = (element, x, y, w, h) => Object.assign(element.style,
      { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });
    if (visible) box(spot, left, top, right - left, bottom - top);
    // Shields intercept only the dim area; the real highlighted control remains usable.
    box(shields[0], 0, 0, innerWidth, top);
    box(shields[1], 0, bottom, innerWidth, innerHeight - bottom);
    box(shields[2], 0, top, left, bottom - top);
    box(shields[3], right, top, innerWidth - right, bottom - top);
    const point = tourPlacement(anchor, card.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
    card.style.left = `${point.left}px`;
    card.style.top = `${point.top}px`;
  }
  function schedule() { if (!frame && index >= 0) frame = requestAnimationFrame(position); }
  function show(value) {
    index = value;
    const step = ONBOARDING_STEPS[index];
    prepare(step.page);
    root.querySelector("#tour-title").textContent = step.title;
    root.querySelector("#tour-description").textContent = index === 5 ? lockDescription() : step.text;
    root.querySelector("#tour-progress").textContent = `${index + 1} / ${ONBOARDING_STEPS.length}`;
    next.textContent = index === ONBOARDING_STEPS.length - 1 ? "开始使用" : "下一步";
    back.disabled = index === 0;
    observer.disconnect();
    target = document.querySelector(step.target);
    // A select/output needs its label/row outlined, not only its tiny glyph box.
    if (index === 1) target = target?.closest("label") ?? target;
    if (index === 4) target = target?.closest(".sync-row") ?? target;
    target?.scrollIntoView({ block: "nearest", behavior: "instant" });
    observer.observe(card);
    if (target) observer.observe(target);
    position();
    next.focus({ preventScroll: true });
  }
  function finish() {
    if (index < 0) return;
    index = -1;
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    root.hidden = true;
    document.body.classList.remove("is-onboarding");
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
    document.removeEventListener("keydown", onKey, true);
    restore();
    if (origin?.isConnected && !origin.closest("[inert]")) origin.focus({ preventScroll: true });
    dismiss();
  }
  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
    if (event.key === "Tab") {
      const buttons = [...card.querySelectorAll("button")].filter((button) => !button.disabled);
      const current = buttons.indexOf(document.activeElement);
      if (current < 0 || (!event.shiftKey && current === buttons.length - 1) || (event.shiftKey && current === 0)) {
        event.preventDefault();
        buttons[event.shiftKey ? buttons.length - 1 : 0].focus({ preventScroll: true });
      }
    }
  }
  back.addEventListener("click", () => { if (index > 0) show(index - 1); });
  next.addEventListener("click", () => index === ONBOARDING_STEPS.length - 1 ? finish() : show(index + 1));
  root.querySelector('[data-tour="skip"]').addEventListener("click", finish);
  return {
    card,
    get active() { return index >= 0; },
    start() {
      if (index >= 0) return;
      origin = document.activeElement;
      root.hidden = false;
      document.body.classList.add("is-onboarding");
      window.addEventListener("resize", schedule);
      document.addEventListener("scroll", schedule, true);
      document.addEventListener("keydown", onKey, true);
      show(0);
    },
    finish,
  };
}
