export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured.' });
  }

  let bullets, format;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    bullets = body.bullets;
    format = body.format || 'SOAP';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!bullets) {
    return res.status(400).json({ error: 'No bullet points provided.' });
  }

  const formatInstructions = format === 'SOAP'
    ? 'SOAP format with four sections labeled SUBJECTIVE, OBJECTIVE, ASSESSMENT, PLAN'
    : 'DAP format with three sections labeled DATA, ASSESSMENT, PLAN';

  const prompt = 'You are an expert licensed clinical supervisor. Given these session bullet points, generate a complete clinical note in ' + format + ' format (' + formatInstructions + ').\n\nSESSION BULLET POINTS:\n' + bullets + '\n\nINSTRUCTIONS:\n1. Write in third person (Client reported...). Professional tone.\n2. Every section must have substantive content.\n3. After the note, evaluate for insurance audit readiness against these 7 criteria:\n   - Medical necessity documented\n   - Functional impairment noted\n   - Treatment modality specified\n   - Progress toward goals mentioned\n   - Risk assessment present (SI/HI or explicit absence)\n   - Between-session tasks included\n   - Next session focus stated\n\nRESPOND WITH ONLY RAW JSON - NO MARKDOWN FORMATTING, NO BACKTICKS, NO ASTERISKS IN THE NOTE TEXT:\n{"note":"SUBJECTIVE:\\nfull subjective section here\\n\\nOBJECTIVE:\\nfull objective section here\\n\\nASSESSMENT:\\nfull assessment section here\\n\\nPLAN:\\nfull plan section here","audit":[{"item":"Medical necessity","status":"ok","note":"explanation"},{"item":"Functional impairment","status":"ok","note":"explanation"},{"item":"Treatment modality","status":"ok","note":"explanation"},{"item":"Progress toward goals","status":"ok","note":"explanation"},{"item":"Risk assessment","status":"ok","note":"explanation"},{"item":"Between-session tasks","status":"warn","note":"explanation"},{"item":"Next session plan","status":"ok","note":"explanation"}]}';

  try {
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1500 }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({ error: data.error ? data.error.message : 'Gemini API error' });
    }

    const raw = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) ? data.candidates[0].content.parts[0].text : '';

    if (!raw) {
      return res.status(200).json({ note: 'No content generated. Please try again.', audit: [] });
    }

    // Clean markdown formatting from raw text
    let cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    // Extract JSON object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    let parsed;
    if (start !== -1 && end !== -1) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (e) {
        parsed = { note: cleaned, audit: [] };
      }
    } else {
      parsed = { note: cleaned, audit: [] };
    }

    // Clean any markdown from the note text itself
    if (parsed.note) {
      parsed.note = parsed.note
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/\\n/g, '\n');
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Gemini API: ' + err.message });
  }
}
