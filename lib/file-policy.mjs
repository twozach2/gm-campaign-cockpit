import { open } from "node:fs/promises";
import path from "node:path";

const PLAYER_IMAGE_TYPES = Object.freeze({
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

const INLINE_DM_TYPES = new Set([
  ...Object.keys(PLAYER_IMAGE_TYPES),
  ".pdf",
]);

export function playerImageType(filePath) {
  return PLAYER_IMAGE_TYPES[path.extname(filePath).toLowerCase()] || null;
}

export function dmFileDisposition(filePath) {
  return INLINE_DM_TYPES.has(path.extname(filePath).toLowerCase())
    ? "inline"
    : "attachment";
}

export async function verifyPlayerImage(filePath) {
  const contentType = playerImageType(filePath);
  if (!contentType) {
    throw Object.assign(
      new Error("Only PNG, JPEG, GIF, and WebP images may be revealed"),
      { status: 400 },
    );
  }

  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const valid =
      (contentType === "image/png" &&
        bytesRead >= 8 &&
        header.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )) ||
      (contentType === "image/jpeg" &&
        bytesRead >= 3 &&
        header[0] === 0xff &&
        header[1] === 0xd8 &&
        header[2] === 0xff) ||
      (contentType === "image/gif" &&
        bytesRead >= 6 &&
        ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) ||
      (contentType === "image/webp" &&
        bytesRead >= 12 &&
        header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WEBP");

    if (!valid) {
      throw Object.assign(
        new Error("Image contents do not match the file extension"),
        { status: 400 },
      );
    }
    return contentType;
  } finally {
    await handle.close();
  }
}

export function contentDisposition(disposition, filePath) {
  const fallback = path
    .basename(filePath)
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(path.basename(filePath));
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
