const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { formatError } = require('../utils/format-error');

const MEDIA_DIR = path.join(process.cwd(), 'tmp', 'media');
const MEDIA_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// GHL's upload endpoint rejects files over 5 MB.
const GHL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
};

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
};

function mimeFromExt(ext) {
  return MIME_BY_EXT[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function extFromMime(mimeType) {
  if (!mimeType) return '';
  // Strip parameters, e.g. "audio/ogg; codecs=opus" → "audio/ogg"
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
  // Last-ditch: derive a sensible extension from the subtype (e.g. audio/opus → .opus)
  // so audio/video files are never stored extensionless (which breaks playback).
  const [type, subtype] = base.split('/');
  if (type === 'audio' || type === 'video' || type === 'image') {
    if (subtype) return `.${subtype.replace(/^x-/, '')}`;
  }
  return '';
}

// Map a mime type to the coarse media category used by workflow triggers.
// Keep in sync with the categories the phone path already emits.
function mediaCategory(mimeType) {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// Write a buffer to the temp media dir and return its public URL. Files expire
// after an hour, so this is only a fallback for when the GHL upload is unavailable.
// `mimeType` is persisted in a .meta sidecar so the router can serve the correct
// Content-Type even when the extension is missing or non-standard (voice notes, opus).
function storeMediaTemp(buffer, ext, mimeType) {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }

  const base = crypto.randomBytes(16).toString('hex');
  const filename = `${base}${ext || ''}`;
  const filePath = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  // Sidecar with the real content-type, so playback never depends on the extension.
  if (mimeType) {
    try {
      fs.writeFileSync(`${filePath}.meta`, mimeType.split(';')[0].trim());
    } catch {
      // non-fatal — router falls back to extension-based detection
    }
  }

  // Schedule cleanup after 1 hour (the periodic sweep also catches restarts)
  setTimeout(() => {
    try {
      fs.unlinkSync(filePath);
      fs.unlinkSync(`${filePath}.meta`);
    } catch {
      // file (or sidecar) may already be deleted
    }
  }, MEDIA_MAX_AGE_MS);

  return `${process.env.BACKEND_URL}/media/${filename}`;
}

/**
 * Turn a downloaded Telegram file into a URL GHL can show in the conversation.
 * Prefers a permanent upload to GHL; falls back to our 1-hour temp link if the
 * file is too big for GHL or the upload fails, so the message still goes through.
 */
async function persistAttachment(ghlService, { locationId, contactId, buffer, filename, mimeType }) {
  // Prefer an extension from the mime type for audio/video so a missing/odd filename
  // extension never leaves the temp file unplayable. Fall back to the filename's own ext.
  const ext = extFromMime(mimeType) || path.extname(filename || '');

  if (buffer.length <= GHL_UPLOAD_MAX_BYTES) {
    try {
      return await ghlService.uploadAttachment(locationId, {
        contactId,
        buffer,
        filename: filename || `file${ext}`,
        mimeType: mimeType || mimeFromExt(ext),
      });
    } catch (err) {
      console.warn(
        `[Media] GHL upload failed for ${locationId}, using temp link: ${formatError(err)}`,
      );
    }
  } else {
    console.warn(
      `[Media] ${filename || 'file'} is ${buffer.length} bytes (> 5 MB GHL limit), using temp link`,
    );
  }

  return storeMediaTemp(buffer, ext, mimeType);
}

module.exports = {
  MEDIA_DIR,
  MEDIA_MAX_AGE_MS,
  mimeFromExt,
  extFromMime,
  mediaCategory,
  storeMediaTemp,
  persistAttachment,
};
