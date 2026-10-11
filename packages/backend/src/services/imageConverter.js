const sharp = require('sharp');
const path = require('path');

async function optimizeImageForDetection(buffer, maxWidth = 2000, maxHeight = 2000) {
  try {
    return await sharp(buffer)
      .rotate()
      .resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .toBuffer();
  } catch (err) {
    console.error('Image optimization error:', err);
    return buffer;
  }
}

async function convertHeicToJpeg(buffer, maxWidth = 2048, maxHeight = 2048) {
  return await sharp(buffer)
    .rotate()
    .resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function isHeicFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.heic' || ext === '.heif';
}

async function convertPhotoBuffer(buffer, photoName) {
  const ext = path.extname(photoName).toLowerCase();

  if (ext === '.heic' || ext === '.heif') {
    // Pass HEIC buffer as-is — the Python daemon handles HEIC via pillow-heif
    return buffer;
  }

  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return optimizeImageForDetection(buffer);
  }

  throw new Error(`Unsupported image format: ${ext}`);
}

module.exports = { convertPhotoBuffer, optimizeImageForDetection, convertHeicToJpeg, isHeicFile };
