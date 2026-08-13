// POST /api/classify-job
// Body: { description: string, images?: string[] (data URIs, max 4) }
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
const Anthropic = require('@anthropic-ai/sdk');

const MANUAL_REVIEW_REASON_NO_AI = 'AI photo assessment is not yet turned on for this account — a MySubbies team member will review your request and follow up with a price.';
const CONFIDENCE_AUTO_QUOTE = 95;
const CONFIDENCE_ASK_MORE = 75;

// Keep this list in sync with DEFAULT_CATEGORIES labels in
// mysubbies-website.html — it's passed to the model so it only ever
// suggests a category that actually exists on the rate card.
const KNOWN_CATEGORIES = [
  'Fencing', 'Pergola', 'Decking', 'Grass Installation', 'Retaining Wall',
  'Concreting', 'Gardening & Lawn Mowing', 'Tree Pruning & Removal', 'Painting',
  'Rendering', 'Cabinetry', 'Stonemason', 'Flooring', 'Earth Works', 'Demolition',
  'Skip Bins', 'Cleaning', 'Tiling', 'Tiled Roof Repair', 'Electrical', 'Plumbing',
  'Handyman', 'Property Maintenance', 'Small Outdoor & Construction Repairs',
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
    // no category, or confidence too low to say anything useful. A
    // regulated trade or a noted compliance concern no longer forces full
    // manual review by itself: we still name the trade and hand off to
    // booking, just flagged needsSiteVisit so the price shown is tentative
    // (same existing "needs a site visit" mechanism the rate card already
    // uses for individually-flagged tasks) rather than a blind fixed quote.
    if (!category || confidence < CONFIDENCE_ASK_MORE) {
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
