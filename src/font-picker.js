import { lyricFontFamily } from "./settings.js";

export function normalizeFontCatalog(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const name = typeof value === "string" ? value : value?.family;
    const family = typeof name === "string" ? name.trim() : "";
    if (!family || family.startsWith("@") || seen.has(family.toLocaleLowerCase())) return [];
    seen.add(family.toLocaleLowerCase());
    return [{
      family,
      displayName: typeof value?.displayName === "string" ? value.displayName.trim() || family : family,
      aliases: Array.isArray(value?.aliases) ? value.aliases.filter((name) => typeof name === "string") : [],
    }];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

export function filterFontCatalog(fonts, query) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return fonts.filter((font) => {
    const names = [font.family, font.displayName, ...font.aliases].join("\n").toLocaleLowerCase();
    return words.every((word) => names.includes(word));
  });
}

export function resolveInstalledFont(fonts, selected) {
  const name = selected.trim().toLocaleLowerCase();
  const exact = fonts.find((font) => [font.family, font.displayName, ...font.aliases].some((alias) => alias.toLocaleLowerCase() === name));
  if (exact) return exact.family;
  const parent = fonts.flatMap((font) => [font.family, font.displayName, ...font.aliases].flatMap((alias) => {
    const prefix = `${alias.toLocaleLowerCase()} `;
    const style = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    return /^(?:(?:semi|extra|ultra|demi)?(?:bold|light)|regular|medium|black|heavy|thin|italic|oblique|semib|semil)(?:\s+(?:italic|oblique))?$/.test(style)
      ? [{ family: font.family, length: alias.length }] : [];
  })).sort((left, right) => right.length - left.length);
  if (parent.length) return parent[0].family;
  // Repair only unambiguous names truncated by the previous LOGFONT reader.
  if (selected.length !== 31) return null;
  const matches = fonts.filter((font) => [font.family, font.displayName, ...font.aliases].some((alias) => alias.toLocaleLowerCase().startsWith(name)));
  return matches.length === 1 ? matches[0].family : null;
}

export function createFontPicker({ button, popup, search, list, status, label, getSelected, onSelect }) {
  let catalog = [];
  let filtered = [];
  let activeIndex = 0;
  let open = false;

  function sync() {
    const selected = getSelected();
    const font = catalog.find((item) => item.family === selected);
    label.textContent = font?.displayName || selected;
    button.title = font && font.displayName !== font.family ? `${font.displayName} · ${font.family}` : selected;
  }

  function close({ restoreFocus = false } = {}) {
    if (!open) return;
    open = false;
    if (popup.hidePopover && popup.matches(":popover-open")) popup.hidePopover();
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    if (restoreFocus) button.focus({ preventScroll: true });
  }

  function select(font) {
    onSelect(font.family);
    sync();
    close({ restoreFocus: true });
  }

  function highlight(index) {
    if (!filtered.length) { search.removeAttribute("aria-activedescendant"); return; }
    activeIndex = (index + filtered.length) % filtered.length;
    list.querySelector(".is-highlighted")?.classList.remove("is-highlighted");
    const option = list.children[activeIndex];
    option.classList.add("is-highlighted");
    option.querySelector(".font-option-sample").style.fontFamily = lyricFontFamily(filtered[activeIndex].family);
    search.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }

  function positionMenu() {
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - margin * 2);
    popup.style.width = `${width}px`;
    const first = list.firstElementChild;
    const last = list.lastElementChild;
    const rowsHeight = first && last ? last.offsetTop + last.offsetHeight - first.offsetTop : 0;
    const below = window.innerHeight - rect.bottom - margin * 2;
    const above = rect.top - margin * 2;
    const height = Math.min(350, Math.max(above, below), search.offsetHeight + status.offsetHeight + rowsHeight + 36);
    popup.style.height = `${height}px`;
    popup.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    popup.style.top = `${below >= height ? rect.bottom + margin : Math.max(margin, rect.top - height - margin)}px`;
  }

  function render() {
    filtered = filterFontCatalog(catalog, search.value);
    list.replaceChildren();
    status.textContent = filtered.length ? `${filtered.length} / ${catalog.length} 款 · 选择后应用` : "没有匹配的字体，试试中文名或英文名";
    const selected = getSelected();
    for (const [index, font] of filtered.entries()) {
      const option = document.createElement("button");
      option.id = `font-option-${index}`;
      option.className = "font-option";
      option.type = "button";
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(font.family === selected));
      option.title = font.displayName !== font.family ? `${font.displayName}\n${font.family}` : font.family;
      const copy = document.createElement("span");
      copy.className = "font-option-name";
      copy.textContent = font.displayName;
      const sample = document.createElement("span");
      sample.className = "font-option-sample";
      sample.textContent = "Aa 字";
      sample.setAttribute("aria-hidden", "true");
      option.append(copy, sample);
      option.addEventListener("mouseenter", () => { sample.style.fontFamily = lyricFontFamily(font.family); });
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => select(font));
      list.append(option);
    }
    activeIndex = Math.max(0, filtered.findIndex((font) => font.family === selected));
    positionMenu();
    highlight(activeIndex);
  }

  function show() {
    if (open) { close({ restoreFocus: true }); return; }
    open = true;
    search.value = "";
    popup.hidden = false;
    if (popup.showPopover) popup.showPopover();
    button.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-expanded", "true");
    render();
    search.focus({ preventScroll: true });
  }

  button.addEventListener("click", show);
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) show(); }
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); highlight(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault(); if (filtered[activeIndex]) select(filtered[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close({ restoreFocus: true });
    } else if (event.key === "Tab") close({ restoreFocus: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!popup.contains(event.target) && !button.contains(event.target)) close();
  });
  document.addEventListener("scroll", (event) => {
    if (open && !popup.contains(event.target)) close();
  }, true);
  window.addEventListener("resize", () => close());

  return {
    sync,
    close,
    setFonts(fonts) { catalog = normalizeFontCatalog(fonts); sync(); if (open) render(); return catalog; },
  };
}
