const crypto = require('crypto');

const BUCKET = 'property-work-orders';
const MAX_FILE_BYTES = Math.floor(1.5 * 1024 * 1024);\nconst MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const ALLOWED = {
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  'application/pdf': bytes => bytes.subarray(0, 5).toString() === '%PDF-',
};

function safeFilename(name) {
  const clean = String(name || 'attachment').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '').slice(0, 100);
  return clean || 'attachment';
}

function decodeAttachment(file) {
  if (!file || typeof file.dataUrl !== 'string') throw new Error('Attachment data is required.');
  const match = file.dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ALLOWED[match[1]]) throw new Error('Only JPEG, PNG and PDF attachments are accepted.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('Each attachment must be 5 MB or smaller.');
  if (!ALLOWED[match[1]](bytes)) throw new Error('Attachment content does not match its file type.');
  return { bytes, mime: match[1], name: safeFilename(file.name) };
}

async function storeAttachments(supabase, organisationId, workOrderId, memberId, attachments, kind) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  if (attachments.length > 8) throw new Error('Upload no more than 8 attachments per work order.');
  const rows = [];
  for (const item of attachments) {
    const file = decodeAttachment(item);
    const path = organisationId + '/' + workOrderId + '/' + crypto.randomUUID() + '-' + file.name;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.mime, upsert: false });
    if (error) throw error;
    rows.push({
      work_order_id: workOrderId,
      uploaded_by_member_id: memberId || null,
      file_kind: kind || 'request_photo',
      original_name: file.name,
      storage_path: path,
      mime: file.mime,
      size_bytes: file.bytes.length,
    });
  }
  const { data, error } = await supabase.from('pm_work_order_files').insert(rows).select('*');
  if (error) throw error;
  return data || [];
}

async function signFiles(supabase, rows) {
  const result = [];
  for (const row of (rows || [])) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, 300);
    result.push({
      id: row.id,
      kind: row.file_kind,
      name: row.original_name,
      mime: row.mime,
      size: row.size_bytes,
      ...(error || !data ? { unavailable: true } : { signedUrl: data.signedUrl, expiresIn: 300 }),
    });
  }
  return result;
}

module.exports = { BUCKET, MAX_FILE_BYTES, MAX_TOTAL_BYTES, safeFilename, decodeAttachment, storeAttachments, signFiles };
