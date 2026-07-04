/**
 * Generate the Roxy app icon set from the source avatar (icon.png).
 *
 * Produces squircle (Apple-style superellipse) icons:
 *   build/icon.icns        — macOS (padded, dock convention)
 *   build/icon.ico         — Windows (full-bleed)
 *   build/icon.png         — Linux / electron-builder (1024, full-bleed)
 *   build/icons/<n>x<n>.png — Linux size set
 *   resources/icon.png     — runtime BrowserWindow / taskbar icon (512, full-bleed)
 *   resources/icon-mac.png — macOS dock icon (512, padded to dock convention)
 *   src/renderer/src/assets/roxy.png — in-app avatar (512)
 *
 * Run: npm run icons
 */
import sharp from 'sharp'
import png2icons from 'png2icons'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'icon.png')
const N = 5 // squircle exponent — higher = squarer; ~5 matches Apple's icon shape

/** SVG path tracing a superellipse (squircle) inscribed in a `size` box. */
function squirclePath(size, inset = 0) {
  const a = size / 2 - inset
  const c = size / 2
  const steps = 720
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const ct = Math.cos(t)
    const st = Math.sin(t)
    const x = c + Math.sign(ct) * a * Math.pow(Math.abs(ct), 2 / N)
    const y = c + Math.sign(st) * a * Math.pow(Math.abs(st), 2 / N)
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)} `
  }
  return d + 'Z'
}

function squircleMask(size) {
  const inset = Math.max(1, Math.round(size * 0.004))
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<path d="${squirclePath(size, inset)}" fill="#fff"/></svg>`
  )
}

/** Mask the source into a squircle, optionally padded inside a `size` canvas. */
async function squircleIcon(srcBuf, size, contentScale) {
  const content = Math.round(size * contentScale)
  const pad = Math.round((size - content) / 2)
  const avatar = await sharp(srcBuf).resize(content, content, { fit: 'cover' }).png().toBuffer()
  const masked = await sharp(avatar)
    .composite([{ input: squircleMask(content), blend: 'dest-in' }])
    .png()
    .toBuffer()
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: masked, top: pad, left: pad }])
    .png()
    .toBuffer()
}

const src = readFileSync(SRC)
const meta = await sharp(src).metadata()
console.log(`Source icon.png: ${meta.width}x${meta.height}`)

mkdirSync(join(root, 'build', 'icons'), { recursive: true })
mkdirSync(join(root, 'resources'), { recursive: true })

// Full-bleed squircle for Windows/Linux/runtime; padded variant for the macOS dock.
const full = await squircleIcon(src, 1024, 0.985)
const mac = await squircleIcon(src, 1024, 0.82)

const resize = (buf, s) => sharp(buf).resize(s, s).png().toBuffer()

writeFileSync(join(root, 'build', 'icon.png'), full)
writeFileSync(join(root, 'resources', 'icon.png'), await resize(full, 512))
// macOS overrides the dock icon at runtime (app.dock.setIcon), which bypasses the
// padded bundle .icns — so ship a matching padded PNG for that call.
writeFileSync(join(root, 'resources', 'icon-mac.png'), await resize(mac, 512))
writeFileSync(join(root, 'src', 'renderer', 'src', 'assets', 'roxy.png'), await resize(full, 512))

writeFileSync(join(root, 'build', 'icon.ico'), png2icons.createICO(full, png2icons.BICUBIC, 0, true))
writeFileSync(join(root, 'build', 'icon.icns'), png2icons.createICNS(mac, png2icons.BICUBIC, 0))

for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(join(root, 'build', 'icons', `${s}x${s}.png`), await resize(full, s))
}

console.log('✓ Generated icns, ico, and png icon set (squircle).')
