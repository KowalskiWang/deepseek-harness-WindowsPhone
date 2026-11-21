// Render the app's tile/icon PNGs from SVG with resvg (no binary assets in git).
//   assets/tiles/*  — APPX manifest images (scale-100 sizes, referenced literally)
//   assets/img/*    — web build: favicon, IE11 pinned-site tiles, touch icon
import { Resvg } from '@resvg/resvg-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BLUE = '#4d6bfe'

function mark(x, y, s, stroke) {
  // ">_" prompt glyph inside an s×s box at (x, y)
  const w = stroke || s * 0.085
  return `<path d="M${x + s * 0.22} ${y + s * 0.3} L${x + s * 0.44} ${y + s * 0.5} L${x + s * 0.22} ${y + s * 0.7}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="square" stroke-linejoin="miter"/>
  <path d="M${x + s * 0.5} ${y + s * 0.71} L${x + s * 0.78} ${y + s * 0.71}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="square"/>`
}

function square(size, { bg = BLUE, pad = 0, transparent = false } = {}) {
  const inner = size - pad * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${transparent ? '' : `<rect width="${size}" height="${size}" fill="${bg}"/>`}
  ${mark(pad, pad, inner)}
</svg>`
}

function wide(w, hgt) {
  const s = hgt * 0.62
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
  <rect width="${w}" height="${hgt}" fill="${BLUE}"/>
  ${mark(hgt * 0.12, (hgt - s) / 2, s)}
  <text x="${hgt * 0.12 + s * 1.02}" y="${hgt * 0.62}" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="${hgt * 0.3}" fill="#fff" letter-spacing="2">DSH</text>
</svg>`
}

function splash(w, hgt) {
  const s = Math.min(w, hgt) * 0.3
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
  <rect x="${(w - s) / 2}" y="${(hgt - s) / 2 - s * 0.2}" width="${s}" height="${s}" fill="${BLUE}"/>
  ${mark((w - s) / 2, (hgt - s) / 2 - s * 0.2, s)}
  <text x="${w / 2}" y="${(hgt + s) / 2 + s * 0.15}" text-anchor="middle" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="${s * 0.18}" fill="#ffffff">DSH Mobile</text>
</svg>`
}

function render(svg, out) {
  const png = new Resvg(svg, { font: { loadSystemFonts: true }, background: 'rgba(0,0,0,0)' }).render().asPng()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, png)
  console.log('wrote', path.relative(root, out), png.length, 'bytes')
}

const tiles = path.join(root, 'assets/tiles')
render(square(150), path.join(tiles, 'Square150x150Logo.png'))
render(square(44), path.join(tiles, 'Square44x44Logo.png'))
render(square(71), path.join(tiles, 'Square71x71Logo.png'))
render(square(50), path.join(tiles, 'StoreLogo.png'))
render(wide(310, 150), path.join(tiles, 'Wide310x150Logo.png'))
render(splash(480, 800), path.join(tiles, 'SplashScreen.png'))

const img = path.join(root, 'assets/img')
render(square(64), path.join(img, 'icon-64.png'))
render(square(144), path.join(img, 'tile-144.png'))
render(square(70), path.join(img, 'tile-70.png'))
render(square(150), path.join(img, 'tile-150.png'))
render(wide(310, 150), path.join(img, 'tile-310x150.png'))
render(square(310), path.join(img, 'tile-310.png'))
