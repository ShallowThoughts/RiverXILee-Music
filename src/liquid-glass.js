// Geometry adapted from the local Mineradio control surface (GPL-3.0).
// Baseline: liquid-glass-control/references/liquid-glass-control.md.
export const GLASS_CHANNELS = [48, 44, 40];

export function glassDimensions(width, height, radius) {
  const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min,
    Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback));
  const w = bounded(width, 720, 32, 4096);
  const h = bounded(height, 58, 24, 2160);
  return { width: w, height: h, radius: bounded(radius, 24, 0, Math.min(w, h) / 2) };
}

export function displacementMap(width, height, radius) {
  const size = glassDimensions(width, height, radius);
  const { width: w, height: h, radius: r } = size;
  const edge = Math.min(w, h) * 0.035;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="r" x1="100%" x2="0%"><stop stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="red"/></linearGradient>
      <linearGradient id="b" x2="0%" y2="100%"><stop stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="blue"/></linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="black"/>
    <rect width="${w}" height="${h}" rx="${r}" fill="url(#r)"/>
    <rect width="${w}" height="${h}" rx="${r}" fill="url(#b)" style="mix-blend-mode:difference"/>
    <rect x="${edge}" y="${edge}" width="${w - edge * 2}" height="${h - edge * 2}" rx="${r}" fill="#808080" style="filter:blur(11px)"/>
  </svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

export function glassFilter(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid glass filter ID");
  const matrices = [
    "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0",
    "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0",
    "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0",
  ];
  return `<filter id="${id}" x="-12%" y="-28%" width="124%" height="156%" color-interpolation-filters="sRGB">
    <feImage width="100%" height="100%" preserveAspectRatio="none" result="map"/>
    ${GLASS_CHANNELS.map((scale, i) => `
      <feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="B" result="d${i}"/>
      <feColorMatrix in="d${i}" values="${matrices[i]}" result="c${i}"/>`).join("")}
    <feBlend in="c0" in2="c1" mode="screen" result="rg"/>
    <feBlend in="rg" in2="c2" mode="screen" result="rgb"/>
    <feGaussianBlur in="rgb" stdDeviation="0.5"/>
  </filter>`;
}

export function initLiquidGlass(surfaces) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("filter-defs");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = "<defs>" + surfaces.map((_, i) => glassFilter(`river-glass-${i}`)).join("") + "</defs>";
  document.body.append(svg);
  const keys = new Map();
  const layers = [];
  const supportsSvg = CSS.supports("backdrop-filter", "url(#river-glass-0)");
  let frame = 0;
  const update = () => {
    frame = 0;
    surfaces.forEach((surface, i) => {
      const w = surface.offsetWidth, h = surface.offsetHeight;
      if (w < 2 || h < 2) return;
      const radius = parseFloat(getComputedStyle(surface).borderRadius);
      const size = glassDimensions(w, h, radius);
      const key = JSON.stringify(size);
      if (keys.get(surface) === key) return;
      keys.set(surface, key);
      svg.querySelector(`#river-glass-${i} feImage`).setAttribute("href",
        displacementMap(size.width, size.height, size.radius));
    });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  surfaces.forEach((surface, i) => {
    const layer = document.createElement("span");
    layer.className = "glass-optics";
    layer.setAttribute("aria-hidden", "true");
    layer.style.setProperty("--glass-refraction", `url(#river-glass-${i})`);
    surface.prepend(layer);
    surface.classList.add("glass-surface");
    if (supportsSvg) surface.classList.add("glass-svg-enabled");
    layers.push(layer);
  });
  const observer = new ResizeObserver(schedule);
  surfaces.forEach((surface) => observer.observe(surface));
  update();
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    svg.remove();
    layers.forEach((layer) => layer.remove());
    surfaces.forEach((surface) => surface.classList.remove("glass-surface", "glass-svg-enabled"));
  };
}
