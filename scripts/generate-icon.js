const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const width = 128;
const height = 128;
const pixels = Buffer.alloc(width * height * 4);

function setPixel(x, y, color) {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return;
  }

  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const closestX = Math.max(left + radius, Math.min(x, right - radius));
  const closestY = Math.max(top + radius, Math.min(y, bottom - radius));
  const distanceX = x - closestX;
  const distanceY = y - closestY;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
}

function drawRoundedRect(left, top, right, bottom, radius, color) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (insideRoundedRect(x, y, left, top, right, bottom, radius)) {
        setPixel(x, y, color);
      }
    }
  }
}

function drawCircle(centerX, centerY, radius, color) {
  const radiusSquared = radius * radius;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const distanceX = x - centerX;
      const distanceY = y - centerY;
      if (distanceX * distanceX + distanceY * distanceY <= radiusSquared) {
        setPixel(x, y, color);
      }
    }
  }
}

function drawLine(x1, y1, x2, y2, thickness, color) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let step = 0; step <= steps; step += 1) {
    const progress = steps === 0 ? 0 : step / steps;
    const centerX = Math.round(x1 + (x2 - x1) * progress);
    const centerY = Math.round(y1 + (y2 - y1) * progress);
    drawCircle(centerX, centerY, thickness, color);
  }
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const body = Buffer.concat([typeBuffer, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, body, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

drawRoundedRect(8, 8, 119, 119, 24, [31, 120, 210, 255]);
drawCircle(85, 42, 20, [255, 204, 64, 255]);

const rayColor = [255, 220, 105, 255];
[
  [85, 12, 85, 20],
  [85, 64, 85, 72],
  [55, 42, 63, 42],
  [107, 42, 115, 42],
  [67, 24, 72, 29],
  [98, 55, 103, 60],
  [67, 60, 72, 55],
  [98, 29, 103, 24]
].forEach(([x1, y1, x2, y2]) => {
  drawLine(x1, y1, x2, y2, 3, rayColor);
});

const cloudColor = [255, 255, 255, 255];
drawCircle(43, 78, 22, cloudColor);
drawCircle(65, 68, 29, cloudColor);
drawCircle(88, 79, 20, cloudColor);
drawRoundedRect(33, 75, 99, 98, 12, cloudColor);

const rows = [];
for (let y = 0; y < height; y += 1) {
  rows.push(Buffer.from([0]));
  rows.push(pixels.subarray(y * width * 4, (y + 1) * width * 4));
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0])),
  chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
  chunk("IEND", Buffer.alloc(0))
]);

const outputPath = path.resolve(__dirname, "..", "icon.png");
fs.writeFileSync(outputPath, png);
console.log(`Generated icon: ${outputPath}`);
