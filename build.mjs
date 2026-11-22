// Build: bundle src -> dist/app.js, copy public/, generate PNG icons.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = "dist";
if (existsSync(OUT)) for (const f of readdirSync(OUT)) rmSync(`${OUT}/${f}`, { recursive: true, force: true });
mkdirSync(`${OUT}/icons`, { recursive: true });
cpSync("public", OUT, { recursive: true });

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["safari15"],
  outfile: `${OUT}/app.js`,
  legalComments: "none",
});

const stamp = Date.now().toString(36);
const sw = readFileSync(`${OUT}/sw.js`, "utf8").replace("__BUILD__", stamp);
writeFileSync(`${OUT}/sw.js`, sw);
writeFileSync(`${OUT}/.nojekyll`, "");

// ---------- icon: green tile with a white progress ring + dot ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2;
  const rOut = size * 0.33, rIn = size * 0.245;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let r = Math.round(15 + (18 - 15) * t), g = Math.round(157 + (184 - 157) * t), b = Math.round(88 + (134 - 88) * t);
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      let ang = Math.atan2(dx, -dy); // 0 at top, clockwise
      if (ang < 0) ang += 2 * Math.PI;
      const inRing = d >= rIn && d <= rOut;
      let white = 0;
      if (inRing) white = ang <= Math.PI * 1.55 ? 1 : 0.35;
      // rounded caps
      const capR = (rOut - rIn) / 2, mid = (rOut + rIn) / 2;
      for (const a of [0, Math.PI * 1.55]) {
        const px = cx + Math.sin(a) * mid, py = cy - Math.cos(a) * mid;
        if (Math.hypot(x + 0.5 - px, y + 0.5 - py) <= capR) white = 1;
      }
      if (d <= size * 0.08) white = 1; // center dot
      r = Math.round(r + (255 - r) * white);
      g = Math.round(g + (255 - g) * white);
      b = Math.round(b + (255 - b) * white);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const s of [180, 192, 512]) writeFileSync(`${OUT}/icons/icon-${s}.png`, png(s));

console.log("Built to", OUT);
