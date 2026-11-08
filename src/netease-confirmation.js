export const CONFIRMATION_STAGES = {
  purpose: { title: "临时启用进度控制", step: "1 / 2", icon: "arrows-clockwise", action: "查看风险提醒", cancel: "暂不开启" },
  risk: { title: "开启前，请确认风险", step: "2 / 2", icon: "shield-warning", action: "确认风险并重启", cancel: "取消开启" },
  restore: { title: "恢复网易云普通模式", step: "", icon: "arrows-clockwise", action: "重启并恢复", cancel: "保持当前模式" },
};

// A native <dialog> supplies top-layer isolation, focus trapping and Escape handling.
// Only an explicit action-button click approves; all other exits return false.
export function createNeteaseConfirmation(doc = document) {
  const dialog = doc.createElement("dialog");
  dialog.className = "netease-confirmation";
  dialog.setAttribute("aria-labelledby", "netease-confirm-title");
  dialog.setAttribute("aria-describedby", "netease-confirm-message");
  dialog.innerHTML = `<div class="consent-heading">
      <span class="consent-icon" aria-hidden="true"><i class="ph ph-arrows-clockwise"></i></span>
      <h2 id="netease-confirm-title"></h2><span class="consent-step" aria-label="确认步骤"></span>
    </div>
    <div class="consent-copy" id="netease-confirm-message"></div>
    <footer class="consent-actions"><button type="button" data-consent="cancel" autofocus></button>
      <button type="button" data-consent="accept"></button></footer>`;
  doc.body.append(dialog);
  const title = dialog.querySelector("h2"), step = dialog.querySelector(".consent-step");
  const message = dialog.querySelector(".consent-copy"), icon = dialog.querySelector(".consent-icon i");
  const cancel = dialog.querySelector('[data-consent="cancel"]');
  const accept = dialog.querySelector('[data-consent="accept"]');
  let pending = null, timer;
  function finish(accepted) {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    clearTimeout(timer);
    if (dialog.open) dialog.close();
    resolve(accepted === true);
  }
  cancel.addEventListener("click", () => finish(false));
  accept.addEventListener("click", () => finish(true));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
  dialog.addEventListener("close", () => { if (!dialog.open) finish(false); });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.repeat) event.preventDefault(); });
  return {
    dialog,
    cancel: () => finish(false),
    show(request) {
      const config = CONFIRMATION_STAGES[request?.stage];
      if (!config || typeof request.message !== "string" || pending) return Promise.resolve(false);
      title.textContent = config.title;
      step.textContent = config.step;
      step.hidden = !config.step;
      icon.className = `ph ph-${config.icon}`;
      dialog.dataset.stage = request.stage;
      message.replaceChildren();
      for (const text of request.message.split(/\n\n+/)) {
        const paragraph = doc.createElement("p");
        paragraph.textContent = text;
        message.append(paragraph);
      }
      cancel.textContent = config.cancel;
      accept.textContent = config.action;
      return new Promise((resolve) => {
        pending = resolve;
        try { dialog.showModal(); message.scrollTop = 0; cancel.focus({ preventScroll: true }); }
        catch { finish(false); return; }
        timer = setTimeout(() => finish(false), 110_000);
      });
    },
  };
}
