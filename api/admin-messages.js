// POST /api/admin-messages  Body: { action: 'send', contractorEmails: string[], subject?, body, attachmentDataUrl?, attachmentFilename?, attachmentMime? }
//                           Body: { action: 'reply', contractorEmail, body }  -- contractor replying in their own thread
//                           Body: { action: 'markRead', messageId, contractorEmail }  -- contractor reading an admin-sent message
//                           Body: { action: 'adminMarkRead', contractorEmail }  -- admin reading a contractor's reply/replies
// GET  /api/admin-messages?contractorEmail=...
//
// Standalone admin<->contractor messaging (added Aug 2026, two-way as of a
// later pass), separate from the existing per-job internalMessages thread
// (job.internalMessages in mysubbies-admin-portal.html/
// mysubbies-contractor-portal.html) -- that's a job-scoped conversation;
// this is a standalone channel with no job involved, e.g. "here's the
// updated rate card, please review" -- and now a contractor can reply
// directly in it. One row per message (not per-recipient-and-shared-body
// any more once a reply exists, but a broadcast to N contractors is still N
// rows sharing the same body/attachment) in admin_contractor_messages --
// see supabase/schema_v7_admin_contractor_messages.sql +
// schema_v8_two_way_admin_contractor_messages.sql (adds sender_role).
//
// Also emails (fire-and-forget, same non-blocking pattern as api/notify.js)
// so whoever isn't currently in the portal still finds out: recipients on
// admin 'send', ADMIN_NOTIFY_EMAIL on a contractor 'reply'.
const { getSupabase } = require('./_lib/clients');
const { sendEmail, wrapEmail } = require('./_lib/email');
const { requireAdmin } = require('./_lib/adminAuth');

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'accounts@mysubbies.com.au';

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
        // Ascending (oldest first) -- this reads as a chat thread now that
        // replies exist, not a stack of separate notification cards.
        .order('sent_at', { ascending: true })
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

    if (action === 'adminMarkRead') {
      if (!requireAdmin(req, res)) return;
      const { contractorEmail } = req.body || {};
      if (!contractorEmail) { res.status(400).json({ error: 'contractorEmail is required.' }); return; }
      const { error } = await supabase
        .from('admin_contractor_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('contractor_email', contractorEmail)
        .eq('sender_role', 'contractor')
        .is('read_at', null);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'reply') {
      const { contractorEmail, body, attachmentDataUrl, attachmentFilename, attachmentMime } = req.body || {};
      if (!contractorEmail || !body || !body.trim()) { res.status(400).json({ error: 'contractorEmail and body are required.' }); return; }
      // Same server-side backstop as the 'send' action -- client already
      // enforces a cap before this is ever called.
      if (attachmentDataUrl && attachmentDataUrl.length > 6 * 1024 * 1024) {
        res.status(400).json({ error: 'Attachment is too large — please use a file under 4MB.' }); return;
      }
      const { data, error } = await supabase
        .from('admin_contractor_messages')
        .insert({
          contractor_email: contractorEmail, sender_role: 'contractor', subject: null, body,
          attachment_data_url: attachmentDataUrl || null,
          attachment_filename: attachmentFilename || null,
          attachment_mime: attachmentMime || null,
        })
        .select()
        .single();
      if (error) throw error;

      sendEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `Contractor reply: ${contractorEmail}`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">New reply from a contractor</h2>
          <p><strong>${String(contractorEmail).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))}</strong></p>
          <p style="white-space:pre-wrap;">${String(body).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))}</p>
          ${attachmentFilename ? `<p>Attachment: <strong>${String(attachmentFilename).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))}</strong> — view it in the admin portal.</p>` : ''}
          <p><a href="https://mysubbies-site.vercel.app/mysubbies-admin-portal.html">Open Admin Portal →</a></p>
        `),
      }).catch(() => {});

      res.status(200).json({ ok: true, message: data });
      return;
    }

    if (action === 'send') {
      if (!requireAdmin(req, res)) return;
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
        sender_role: 'admin',
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
