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

  const prompt = 'You are an expert clinical documentation assistant.\n\nFIRST, check the input below. If it does NOT plausibly describe a therapy/counseling session (e.g. it is unrelated text, a list of unrelated items, random characters, or otherwise not session-related content), respond with ONLY this JSON and nothing else: {"error":"not_clinical"}\n\nIf it DOES plausibly describe a therapy/counseling session (even briefly or informally), continue with the instructions below.\n\nGiven these session bullet points, generate a complete clinical note in ' + format + ' format (' + formatInstructions + ').\n\nSESSION BULLET POINTS (this is the ONLY information the clinician documented):\n' + bullets + '\n\nNOTE-WRITING INSTRUCTIONS:\n1. Write in third person (Client reported...). Professional tone.\n2. Every section must have substantive content, written in clinical language.\n3. Keep each section concise (3-5 sentences) so the full response fits within the token limit.\n4. You may rephrase and organize the bullet points into clinical language, but DO NOT invent new clinical details, symptoms, behaviors, quotes, severity ratings, or observations that are not stated or clearly implied by the bullet points. If a section would otherwise be thin, keep it brief rather than adding fabricated content. Never assume risk status (e.g. do not write "denies SI/HI") unless the bullet points say so.\n\nCHECKLIST INSTRUCTIONS:\nAfter writing the note, check the ORIGINAL SESSION BULLET POINTS (not the note you wrote) against these 7 documentation elements that insurers commonly look for. For each, mark "present" only if the bullet points themselves explicitly contain that information. Mark "missing" if it is not explicitly stated in the bullet points, even if you could infer or guess it. Do NOT give credit for details that only appear because you elaborated them while writing the note.\n\n1. Medical necessity \u2014 "present" only if the bullets state a specific symptom, severity/rating, or clinical problem (e.g. "anxiety 7/10", "depressed mood").\n2. Functional impairment \u2014 "present" only if the bullets describe how the issue affects daily life, work, sleep, relationships, or functioning.\n3. Treatment modality \u2014 "present" only if the bullets name a specific technique or intervention used in session (e.g. "CBT reframing", "grounding exercise"). Generic terms like "talked" or "discussed" alone do not count.\n4. Progress toward goals \u2014 "present" only if the bullets reference change over time, improvement, setback, or comparison to a prior session/goal.\n5. Risk assessment \u2014 "present" only if the bullets explicitly mention SI/HI, safety, or risk status (presence OR explicit absence). If risk is not mentioned at all, mark "missing" \u2014 do not assume absence of risk.\n6. Between-session tasks \u2014 "present" only if the bullets mention a specific homework assignment, practice task, or action item for the client.\n7. Next session plan \u2014 "present" only if the bullets mention what will happen, be reviewed, or be focused on next session. A date alone with no stated focus counts as "missing".\n\nThis checklist is informational only \u2014 always generate the note regardless of how many items are present or missing. Be strict and literal: when in doubt, mark "missing".\n\nRESPOND WITH ONLY RAW JSON - NO MARKDOWN FORMATTING, NO BACKTICKS, NO ASTERISKS IN THE NOTE TEXT. The checklist array MUST always be included and complete (all 7 items):\n{"note":"SUBJECTIVE:\\nfull subjective section here\\n\\nOBJECTIVE:\\nfull objective section here\\n\\nASSESSMENT:\\nfull assessment section here\\n\\nPLAN:\\nfull plan section here","audit":[{"item":"Medical necessity","status":"ok","note":"brief note referencing the bullet points"},{"item":"Functional impairment","status":"ok","note":"brief note"},{"item":"Treatment modality","status":"ok","note":"brief note"},{"item":"Progress toward goals","status":"warn","note":"brief note on what is missing"},{"item":"Risk assessment","status":"ok","note":"brief note"},{"item":"Between-session tasks","status":"warn","note":"brief note on what is missing"},{"item":"Next session plan","status":"ok","note":"brief note"}]}\n\nIn the JSON above, "status" must be either "ok" (present in bullets) or "warn" (missing from bullets) \u2014 no other values.';

  try {
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 3000 }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({ error: data.error ? data.error.message : 'Gemini API error' });
    }

    const candidate = data.candidates && data.candidates[0];
    const raw = (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) ? candidate.content.parts[0].text : '';
    const finishReason = candidate ? candidate.finishReason : 'UNKNOWN';

    // Debug logging - visible in Vercel function logs
    console.log('finishReason:', finishReason);
    console.log('raw length:', raw.length);
    console.log('raw tail:', raw.slice(-200));

    if (!raw) {
      return res.status(200).json({ note: 'No content generated. Please try again.', audit: [] });
    }

    // Clean markdown formatting from raw text
    let cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    // Extract JSON object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    let parsed;
    let parseFailed = false;

    if (start !== -1 && end !== -1) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (e) {
        parseFailed = true;
      }
    } else {
      parseFailed = true;
    }

    if (parseFailed) {
      // Likely a truncated response (hit maxOutputTokens before JSON closed).
      // Try to salvage at least the note text via regex instead of dumping raw JSON.
      const noteMatch = cleaned.match(/"note"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"audit"|$)/);
      let salvagedNote = noteMatch ? noteMatch[1] : cleaned;

      // Unescape common JSON escapes
      salvagedNote = salvagedNote
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      parsed = {
        note: salvagedNote + '\n\n[Note: response was cut off before completing. Try shortening your input or click Generate again.]',
        audit: [],
        truncated: true
      };
    }

    // Clean any markdown from the note text itself
    if (parsed.note) {
      parsed.note = parsed.note
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/\\n/g, '\n');
    }

    // Handle the "not a clinical session" case
    if (parsed.error === 'not_clinical') {
      return res.status(200).json({ error: 'not_clinical' });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Gemini API: ' + err.message });
  }
}
