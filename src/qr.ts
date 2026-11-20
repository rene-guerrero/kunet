/**
 * A QR code as an inline SVG string (one path, no external requests), for the "scan to join" card.
 * Dark modules use currentColor so the page decides the colours; keep a light background behind it,
 * most camera apps want dark-on-light.
 */
import qrcode from 'qrcode-generator';

export function qrSvg(text: string, opts: { margin?: number; label?: string } = {}): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = opts.margin ?? 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  }
  const size = n + m * 2;
  const label = (opts.label ?? text).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><path d="${d}" fill="currentColor"/></svg>`;
}
