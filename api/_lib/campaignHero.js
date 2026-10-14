async function generateCampaignHero(supabase, campaign) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const prompt = [
    'Professional photorealistic landscape email hero photograph for MySubbies, a Melbourne property and facilities maintenance business.',
    'Campaign:', String(campaign.name || '').slice(0, 180),
    'Service:', String(campaign.service_category || '').slice(0, 120),
    'Theme:', String(campaign.headline || '').slice(0, 240),
    'Show a realistic Australian property and work scene directly relevant to the campaign.',
    'Natural light, premium editorial architecture photography, authentic equipment and safe working conditions.',
    'No words, letters, logos, watermarks, text overlays or graphic designs.'
  ].join(' ');
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1536x1024', quality: 'medium', n: 1 })
  });
  const data = await response.json();
  if (!response.ok || !data.data?.[0]?.b64_json) throw new Error('Image generation failed: ' + (data.error?.message || response.status));
  const path = 'campaigns/' + campaign.id + '/' + Date.now() + '.png';
  const uploaded = await supabase.storage.from('marketing-images').upload(path, Buffer.from(data.data[0].b64_json, 'base64'), { contentType: 'image/png' });
  if (uploaded.error) throw new Error('Image storage failed: ' + uploaded.error.message);
  return supabase.storage.from('marketing-images').getPublicUrl(path).data.publicUrl;
}
module.exports = { generateCampaignHero };
