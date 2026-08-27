// POST /api/admin-messages  Body: { action: 'send', contractorEmails: string[], subject?, body, attachmentDataUrl?, attachmentFilename?, attachmentMime? }
//                           Body: { action: 'markRead', messageId, contractorEmail }
// GET  /api/admin-messages?contractorEmail=...
//
// Standalone admin-to-panel messaging (added Aug 2026), separate from the
// existing per-job internalMessages thread (job.internalMessages in
// mysubbies-admin-portal.html/mysubbies-contractor-portal.html) -- that's a
// job-scoped conversation; this is admin reaching an approved contractor (or
// several at once) with no job involved, e.g. "here's the updated rate card,
// please review." One row per (message, recipient) in
// admin_contractor_messages -- see supabase/schema_v7_admin_contractor_messages.sql
// -- so unread state is naturally per-contractor and a broadcast to N
// contractors is just N inserted rows sharing the same body/attachment.
//
// Also emails each recipient (fire-and-forget, same non-blocking pattern as
// api/notify.js) so a contractor who doesn't happen to be in the portal
// still finds out.
const { getSupabase } = require('./_lib/clients');
const { sendEmail, wrapEmail } = require('./_lib/email');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { contractorEmail } = req.query || {};
      if (!contractorEmail) { res.status(400).json({ error: 'contractorEmail is required.' }); return; }
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('admin_contractor_messages')
        .select('*')
        .eq('contractor_email', contractorEmail)
        .order('sent_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      res.status(200).json({ messages: data || [] });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { action } = req.body || {};
    const supabase = getSupabase();

    if (action === 'markRead') {
      const { messageId, contractorEmail } = req.body || {};
      if (!messageId || !contractorEmail) { res.status(400).json({ error: 'messageId and contractorEmail are required.' }); return; }
      const { error } = await supabase
        .from('admin_contractor_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('id', messageId)
        .eq('contractor_email', contractorEmail)
        .is('read_at', null);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'send') {
      const { contractorEmails, subject, body, attachmentDataUrl, attachmentFilename, attachmentMime } = req.body || {};
      if (!Array.isArray(contractorEmails) || contractorEmails.length === 0) { res.status(400).json({ error: 'contractorEmails must be a non-empty array.' }); return; }
      if (!body || !body.trim()) { res.status(400).json({ error: 'body is required.' }); return; }
      // A raw, uncompressed attachment can silently exceed Vercel's request-
      // body size limit the same way an uncompressed camera photo did for
      // Fix Something (see mysubbies-website.html's resizeImageFile fix,
      // Aug 2026) -- the client already enforces a cap before this is ever
      // called, this is just the server-side backstop.
      if (attachmentDataUrl && attachmentDataUrl.length > 6 * 1024 * 1024) {
        res.status(400).json({ error: 'Attachment is too large — please use a file under 4MB.' }); return;
      }

      const rows = contractorEmails.map((email) => ({
        contractor_email: email,
        subject: subject || null,
        body,
        attachment_data_url: attachmentDataUrl || null,
        attachment_filename: attachmentFilename || null,
        attachment_mime: attachmentMime || null,
      }));
      const { error } = await supabase.from('admin_contractor_messages').insert(rows);
      if (error) throw error;

      await Promise.all(contractorEmails.map((email) => sendEmail({
        to: email,
        subject: subject ? `MySubbies: ${subject}` : 'New message from MySubbies',
        html: wrapEmail(`
          <h2 style="margin-top:0;">${subject ? subject : 'You have a new message'}</h2>
          <p style="white-space:pre-wrap;">${String(body).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))}</p>
          ${attachmentFilename ? `<p>Attachment: <strong>${attachmentFilename}</strong> — view it in your contractor portal.</p>` : ''}
          <p><a href="https://mysubbies-site.vercel.app/mysubbies-contractor-portal.html">Open Contractor Portal →</a></p>
        `),
      })));

      res.status(200).json({ ok: true, sentTo: contractorEmails.length });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('admin-messages error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
