// POST /api/classify-job
// Body: { description: string, images?: string[] (data URIs, max 4) }
//   OR (task-match mode, see below): { taskMatch: true, category, taskNames, query }
//
// Backs the "Fix Something" entry point: customer uploads a photo and/or
// describes a problem in plain language, without knowing which trade
// category it belongs to. This endpoint's ONLY job is classification —
// which category/service this most likely is, and how confident that guess
// is. It does NOT invent a price: the client takes the returned category +
// service name and looks it up against the real, founder-priced rate card
// (DEFAULT_CATEGORIES in mysubbies-website.html) the same way manual
// category selection already does. If no match is found there, or AI
// confidence is too low, the job is routed to manual review instead of
// guessing — see section 12/13 of the small-jobs brief this implements.
//
// Requires ANTHROPIC_API_KEY (Anthropic Claude, vision-capable) in Vercel
// env vars. Until that's set, every request safely falls back to manual
// review rather than faking a classification — this is a real, working
// fallback state, not a placeholder to swap out later.
//
// --- Task-match mode (added Aug 2026) ---
// Body: { taskMatch: true, category: string, taskNames: string[], query: string }
// Once a customer has already picked a category, the sub-category chip/type-
// ahead (estFindBestTaskMatch in mysubbies-website.html) tries a plain
// substring/keyword match against that category's real task list first —
// this mode is the fallback ONLY when that local match fails, so it's a
// second, smarter attempt at the SAME thing: does this free-text query
// actually describe one of `taskNames`? If yes, we still price it off the
// real rate card exactly as before — this mode never touches pricing for a
// genuine match.
// Only if it genuinely doesn't map to any listed task does this fall through
// to a real, deliberate exception to "never invent a price": an AI-estimated
// Melbourne market range for that specific job. This is explicitly requested
// by the founder (Aug 2026) to stop "service not found" dead-ending the
// booking flow for legitimate jobs the rate card just doesn't happen to
// list yet. To keep this safe: the estimate is never shown or stored as a
// real rate-card price — the client must label it "AI-estimated" distinctly,
// flag the resulting cart item `aiEstimated:true`, and force
// `needsSiteVisit:true` (the existing "tentative, contractor confirms on
// site" mechanism) so nothing is auto-dispatched against an unconfirmed
// number. See mysubbies-admin-portal.html / mysubbies-contractor-portal.html
// job-item rendering for the "AI-estimated price" badge this drives.
const Anthropic = require('@anthropic-ai/sdk');

const MANUAL_REVIEW_REASON_NO_AI = 'AI photo assessment is not yet turned on for this account — a MySubbies team member will review your request and follow up with a price.';
const CONFIDENCE_AUTO_QUOTE = 95; // above this: simple/clear enough to skip clarifying questions
const CONFIDENCE_ASK_MORE = 75;   // prompt guidance only (see prompt text) -- NOT the hard-block bar; a real job (e.g. a custom deck) legitimately scores below this just for having normal follow-up questions, which is not the same as "we can't tell what trade this needs"
const CONFIDENCE_MIN_USABLE = 45; // hard-block bar: below this the category guess itself isn't trustworthy enough to show at all

// Keep this list in sync with DEFAULT_CATEGORIES labels in
// mysubbies-website.html — it's passed to the model so it only ever
// suggests a category that actually exists on the rate card.
const KNOWN_CATEGORIES = [
  'Fencing', 'Pergola', 'Decking', 'Grass Installation', 'Retaining Wall',
  'Concreting', 'Gardening & Lawn Mowing', 'Tree Pruning & Removal', 'Painting',
  'Rendering', 'Cabinetry', 'Stonemason', 'Flooring', 'Earth Works', 'Demolition',
  'Skip Bins', 'Cleaning', 'Tiling', 'Tiled Roof Repair', 'Electrical', 'Plumbing',
  'Handyman', 'Property Maintenance', 'Small Outdoor & Construction Repairs',
  'Pest Control', 'Locksmith', 'Blinds, Curtains & Shutters',
  'Garage Door Service & Repair', 'Gutter Guard Installation',
  'Plastering & Drywall Repair', 'Insulation Installation',
];

// Regulated trades where a wrong guess is a safety issue (section 12).
// Below CONFIDENCE_AUTO_QUOTE, these never get a blind fixed instant
// quote — the customer still gets a trade recommendation and can book,
// but it's flagged needsSiteVisit so the price shown is tentative,
// confirmed by the contractor on site rather than charged automatically.
const ALWAYS_MANUAL_REVIEW_IF_COMPLEX = ['Electrical', 'Plumbing'];

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  if (req.body && req.body.taskMatch) {
    await handleTaskMatch(req, res);
    return;
  }

  try {
    const { description, images } = req.body || {};
    if (!description && (!images || images.length === 0)) {
      res.status(400).json({ error: 'A description or at least one photo is required.' });
      return;
    }

    const anthropic = getAnthropic();
    if (!anthropic) {
      res.status(200).json({
        manualReviewRequired: true,
        reason: MANUAL_REVIEW_REASON_NO_AI,
        confidence: null,
      });
      return;
    }

    const content = [];
    if (description) {
      content.push({ type: 'text', text: `Customer's description of the problem: "${description}"` });
    }
    (images || []).slice(0, 4).forEach((dataUri) => {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUri);
      if (match) {
        content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      }
    });
    content.push({
      type: 'text',
      text: `You are triaging a home-repair request for an Australian trade marketplace called MySubbies. Based on the photo(s) and/or description above, respond with ONLY a JSON object (no other text) in this exact shape:
{
  "category": one of ${JSON.stringify(KNOWN_CATEGORIES)},
  "likelyService": "the specific rate-card-style task name, e.g. 'Gate repair' or 'Toilet cistern internals repair'",
  "confidence": a number 0-100,
  "likelyWork": ["short bullet", "short bullet"],
  "safetyOrComplianceConcerns": "string, or null if none",
  "isRegulatedTrade": true or false (true if this looks like electrical, plumbing or gas work),
  "suggestedQuestions": ["question to ask the customer", "..."]
}
Be conservative with confidence: only score above ${CONFIDENCE_AUTO_QUOTE} if the issue is simple, clearly visible/described, and matches a standard like-for-like job. If the photo/description is ambiguous, unclear, or shows anything beyond a simple standard fix, score below ${CONFIDENCE_ASK_MORE}.`,
    });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
    });

    const raw = message.content.find((b) => b.type === 'text')?.text || '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const category = KNOWN_CATEGORIES.includes(parsed.category) ? parsed.category : null;
    const isComplexRegulated = parsed.isRegulatedTrade && ALWAYS_MANUAL_REVIEW_IF_COMPLEX.includes(category) && confidence < CONFIDENCE_AUTO_QUOTE;

    // Hard block only when we genuinely can't identify a usable trade —
    // no category, or confidence too low to trust the category guess at
    // all (CONFIDENCE_MIN_USABLE, deliberately low). A real job with normal
    // follow-up questions (custom dimensions, permits, site specifics) will
    // legitimately score well below CONFIDENCE_AUTO_QUOTE per the prompt
    // above -- that's "ask more questions", not "we have no idea what this
    // is", so it must not block the recommendation. A regulated trade or a
    // noted compliance concern also no longer forces full manual review by
    // itself: we still name the trade and hand off to booking, just flagged
    // needsSiteVisit so the price shown is tentative (same existing "needs
    // a site visit" mechanism the rate card already uses for individually-
    // flagged tasks) rather than a blind fixed quote.
    if (!category || confidence < CONFIDENCE_MIN_USABLE) {
      res.status(200).json({
        manualReviewRequired: true,
        reason: parsed.safetyOrComplianceConcerns
          || 'This needs a quick human check before we can confirm a price — a MySubbies team member will follow up.',
        confidence,
        aiClassification: parsed,
      });
      return;
    }

    res.status(200).json({
      manualReviewRequired: false,
      category,
      likelyService: parsed.likelyService || null,
      confidence,
      likelyWork: Array.isArray(parsed.likelyWork) ? parsed.likelyWork : [],
      suggestedQuestions: Array.isArray(parsed.suggestedQuestions) ? parsed.suggestedQuestions : [],
      askMoreQuestions: confidence < CONFIDENCE_AUTO_QUOTE,
      needsSiteVisit: !!(isComplexRegulated || parsed.safetyOrComplianceConcerns),
      complianceNote: parsed.safetyOrComplianceConcerns || null,
      aiClassification: parsed,
    });
  } catch (err) {
    console.error('classify-job error:', err);
    // Fail safe: never invent a price on error, route to manual review instead.
    res.status(200).json({
      manualReviewRequired: true,
      reason: 'Something went wrong assessing your photo — a MySubbies team member will review it and follow up.',
      confidence: null,
    });
  }
};

// Below this bar the AI isn't confident enough to trust either a task match
// OR a market estimate — same "don't guess" philosophy as CONFIDENCE_MIN_USABLE
// above, just for the narrower task-match scope.
const TASKMATCH_CONFIDENCE_MIN = 40;

async function handleTaskMatch(req, res) {
  try {
    const { category, taskNames, query } = req.body || {};
    if (!category || !Array.isArray(taskNames) || !taskNames.length || !query || !query.trim()) {
      res.status(400).json({ error: 'category, taskNames and query are required.' });
      return;
    }

    const anthropic = getAnthropic();
    if (!anthropic) {
      res.status(200).json({ matched: false, aiEstimate: null, confidence: null,
        reason: 'AI matching is not yet turned on for this account.' });
      return;
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are helping a customer on an Australian (Melbourne) trade marketplace called MySubbies find the right priced task in the "${category}" category. They typed this free-text description of what they need: "${query.trim()}"

Here is the FULL list of real, founder-priced task names available in this category:
${JSON.stringify(taskNames)}

Step 1: Does the customer's description clearly match ONE of the exact task names above (allowing for different phrasing, synonyms, typos)? If so, that is the correct answer — do not estimate a price.

Step 2: Only if nothing in the list is a reasonable match, but this is still a plausible, well-defined ${category} job an Australian licensed tradie would quote for: estimate a typical Melbourne market price range for it (AUD, GST inclusive), based on general knowledge of Australian trade pricing. Be conservative — a wide, honest range beats a falsely precise number.

Respond with ONLY a JSON object (no other text) in this exact shape:
{
  "matchedTaskName": "<one of the exact strings from the list above, or null>",
  "confidence": <0-100, how confident you are in whichever answer you gave>,
  "aiEstimate": null OR { "low": <number>, "high": <number>, "reasoning": "<one short sentence on what's included/assumed>" }
}
Only one of matchedTaskName / aiEstimate should be non-null. If the description is too vague, nonsensical, or not a real job, set both to null and confidence to 0.`,
      }],
    });

    const raw = message.content.find((b) => b.type === 'text')?.text || '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    const matchedTaskName = typeof parsed.matchedTaskName === 'string' && taskNames.includes(parsed.matchedTaskName)
      ? parsed.matchedTaskName : null;

    if (matchedTaskName && confidence >= TASKMATCH_CONFIDENCE_MIN) {
      res.status(200).json({ matched: true, taskName: matchedTaskName, confidence, aiEstimate: null });
      return;
    }

    const est = parsed.aiEstimate;
    const validEstimate = est && typeof est.low === 'number' && typeof est.high === 'number' && est.low > 0 && est.high >= est.low;
    if (validEstimate && confidence >= TASKMATCH_CONFIDENCE_MIN) {
      res.status(200).json({
        matched: false, taskName: null, confidence,
        aiEstimate: { low: Math.round(est.low), high: Math.round(est.high), reasoning: est.reasoning || null },
      });
      return;
    }

    res.status(200).json({ matched: false, taskName: null, aiEstimate: null, confidence,
      reason: "We couldn't confidently price that — try describing it differently, or browse the full task list." });
  } catch (err) {
    console.error('classify-job task-match error:', err);
    res.status(200).json({ matched: false, taskName: null, aiEstimate: null, confidence: null,
      reason: 'Something went wrong — try again, or browse the full task list.' });
  }
}
