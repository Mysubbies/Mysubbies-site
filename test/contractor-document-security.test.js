const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeDocument, safeFilename, storeDocuments, signedDocuments, MAX_FILE_BYTES } = require('../api/_lib/contractorDocuments');

function dataUrl(mime, bytes) { return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`; }

test('document validation accepts genuine PDF/JPEG/PNG signatures and sanitises filenames', () => {
  assert.equal(decodeDocument({ name: '../../licence final.pdf', dataUrl: dataUrl('application/pdf', '%PDF-1.7 test') }).mime, 'application/pdf');
  assert.equal(decodeDocument({ name: 'photo.jpg', dataUrl: dataUrl('image/jpeg', [0xff, 0xd8, 0xff, 1]) }).mime, 'image/jpeg');
  assert.equal(decodeDocument({ name: 'photo.png', dataUrl: dataUrl('image/png', [137,80,78,71,13,10,26,10,1]) }).mime, 'image/png');
  assert.equal(safeFilename('../../licence final.pdf'), 'licence-final.pdf');
});

test('document validation rejects spoofed MIME, unsupported content, malformed data and oversized files', () => {
  assert.throws(() => decodeDocument({ name: 'fake.pdf', dataUrl: dataUrl('application/pdf', 'not pdf') }), /does not match/);
  assert.throws(() => decodeDocument({ name: 'script.svg', dataUrl: dataUrl('image/svg+xml', '<svg/>') }), /Only PDF/);
  assert.throws(() => decodeDocument({ name: 'bad', dataUrl: 'https://public.example/file' }), /Only PDF/);
  assert.throws(() => decodeDocument({ name: 'large.pdf', dataUrl: dataUrl('application/pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_FILE_BYTES)])) }), /5 MB/);
});

test('private upload stores only opaque metadata and Admin receives a five-minute signed URL', async () => {
  let uploaded;
  const bucket = { upload: async (path, bytes, options) => { uploaded = { path, bytes, options }; return { error: null }; },
    createSignedUrl: async (path, seconds) => ({ data: { signedUrl: `https://signed.test/${path}?ttl=${seconds}` }, error: null }) };
  const supabase = { storage: { from: name => { assert.equal(name, 'contractor-documents'); return bucket; } } };
  const docs = await storeDocuments(supabase, 'contractor-id', 'licence', [{ name: 'licence.pdf', dataUrl: dataUrl('application/pdf', '%PDF-test') }]);
  assert.match(uploaded.path, /^contractor-id\/licence\/[0-9a-f-]+-licence\.pdf$/);
  assert.deepEqual(Object.keys(docs[0]).sort(), ['mime', 'name', 'size', 'storagePath'].sort());
  assert.equal('dataUrl' in docs[0], false);
  const signed = await signedDocuments(supabase, docs);
  assert.equal(signed[0].expiresIn, 300);
  assert.match(signed[0].signedUrl, /ttl=300/);
});
