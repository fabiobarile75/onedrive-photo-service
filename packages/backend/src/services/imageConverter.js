const sharp = require('sharp');
const path = require('path');

async function convertHeicToJpeg(heicBuffer) {
  try {
    // Vérifier si c'est du HEIC
    const header = heicBuffer.toString('hex', 0, 12);
    const isFtyp = header.substring(8, 16) === '66747970';  // 'ftyp'
    const isHeic = header.substring(16, 24) === '68656963';  // 'heic'

    if (isFtyp && isHeic) {
      console.log('Converting HEIC to JPEG...');
      const jpegBuffer = await sharp(heicBuffer)
        .rotate()  // Auto-rotate based on EXIF
        .jpeg({ quality: 90, progressive: true })
        .toBuffer();
      return jpegBuffer;
    }

    return heicBuffer;
  } catch (err) {
    console.error('HEIC conversion error:', err.message);
    return heicBuffer;
  }
}

async function optimizeImageForDetection(buffer, maxWidth = 1920, maxHeight = 1080) {
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

async function convertPhotoBuffer(buffer, photoName) {
  const ext = path.extname(photoName).toLowerCase();

  if (ext === '.heic' || ext === '.heif') {
    const converted = await convertHeicToJpeg(buffer);
    return optimizeImageForDetection(converted);
  }

  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return optimizeImageForDetection(buffer);
  }

  throw new Error(`Unsupported image format: ${ext}`);
}

module.exports = { convertHeicToJpeg, convertPhotoBuffer, optimizeImageForDetection };
