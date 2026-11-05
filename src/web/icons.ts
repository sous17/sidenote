// The small line icons on a session's row. Built with DOM calls, like everything drawn on the page.
const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  rename: "M10.8 2.7l2.5 2.5-7.8 7.8-3.2.7.7-3.2zM9.3 4.2l2.5 2.5",
  remove: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5M6.8 7v3.5M9.2 7v3.5",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  play: "M5 3.2v9.6l7.5-4.8z",
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
