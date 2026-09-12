const crypto = require('crypto');

const BUCKET = 'contractor-documents';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED = {
  'application/pdf': bytes => bytes.subarray(0, 5).toString() === '%PDF-',
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
};

function safeFilename(name) {
  const clean = String(name || 'document').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '').slice(0, 100);
  return clean || 'document';
}

function decodeDocument(document) {
  if (!document || typeof document.dataUrl !== 'string') throw new Error('Document data is required.');
  const match = document.dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ALLOWED[match[1]]) throw new Error('Only PDF, JPEG and PNG documents are accepted.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('Each document must be 5 MB or smaller.');
  if (!ALLOWED[match[1]](bytes)) throw new Error('The document content does not match its file type.');
  return { bytes, mime: match[1], originalName: safeFilename(document.name) };
}

async function storeDocuments(supabase, contractorId, kind, documents) {
  if (!Array.isArray(documents)) return [];
  if (documents.length > 10) throw new Error('Upload no more than 10 documents in each section.');
  const stored = [];
  for (const item of documents) {
    // Existing private-storage metadata may be retained during resubmission.
    if (item && item.storagePath && !item.dataUrl) {
      stored.push({ name: safeFilename(item.name), storagePath: item.storagePath, mime: item.mime, size: item.size });
      continue;
    }
    const file = decodeDocument(item);
    const path = `${contractorId}/${kind}/${crypto.randomUUID()}-${file.originalName}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.mime, upsert: false });
    if (error) throw error;
    stored.push({ name: file.originalName, storagePath: path, mime: file.mime, size: file.bytes.length });
  }
  return stored;
}

async function signedDocuments(supabase, documents) {
  return Promise.all((Array.isArray(documents) ? documents : []).map(async document => {
    if (!document.storagePath) return { name: safeFilename(document.name), unavailable: true };
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(document.storagePath, 300);
    return { name: safeFilename(document.name), mime: document.mime, size: document.size,
      ...(error || !data ? { unavailable: true } : { signedUrl: data.signedUrl, expiresIn: 300 }) };
  }));
}

module.exports = { BUCKET, MAX_FILE_BYTES, safeFilename, decodeDocument, storeDocuments, signedDocuments };
