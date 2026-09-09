import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node scripts/remove-image-background.mjs source destination');
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const background = new Uint8Array(width * height);
  const queue = [];
  function visit(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (background[i] || Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) < 235) return;
    background[i] = 1;
    queue.push(i);
  }
  for (let x = 0; x < width; x++) { visit(x, 0); visit(x, height - 1); }
  for (let y = 0; y < height; y++) { visit(0, y); visit(width - 1, y); }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % width, y = Math.floor(i / width);
    visit(x - 1, y); visit(x + 1, y); visit(x, y - 1); visit(x, y + 1);
  }
  for (let i = 0; i < background.length; i++) if (background[i]) data[i * 4 + 3] = 0;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(destination);
  console.log(`Saved ${width}x${height} RGBA image; removed ${queue.length} exterior background pixels.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
