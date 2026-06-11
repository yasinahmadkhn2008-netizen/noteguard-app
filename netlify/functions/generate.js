export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured.' });
  }

  const { bullets, format } = req.body;

  const formatInstructions = format === 'SOAP'
    ? `SOAP format with four labeled sections:
       - SUBJECTIVE: client's reported experience, feelings, concerns
       - OBJECTIVE: clinician's observations, measurable data
       - ASSESSMENT: clinical formulation, diagnosis impression, progress
       - PLAN: treatment plan, interventions, homework, next session focus`
    : `DAP format with three labeled sections:
       - DATA: both subjective reports and objective observations combined
       - ASSESSMENT: clinical formulation, diagnosis impression, progress
       - PLAN: treatment plan, interventions, homework, next session focus`;

  const prompt = `You are an expert licensed clinical supervisor helping a therapist write a professional, insurance-compliant progress note.

Given these session bullet points, generate a complete clinical note in ${format} format, then perform an audit readiness check.

SESSION BULLET POINTS:
${bullets}

INSTRUCTIONS:
1. Write a complete ${format} progress note using ${formatInstructions}
2. Write in third person (e.g., "Client reported..."). Professional but not overly formal.
3. Every section must have substantive content.
4. After the note, evaluate it for insurance audit readiness against these criteria:
   - Medical necessity documented
   - Functional impairment noted
   - Treatment modality specified
   - Progress toward goals mentioned
   - Risk assessment present (SI/HI or explicit statement of absence)
   - Homework or between-session tasks included
   - Next session focus or frequency stated

YOU MUST RESPOND WITH ONLY RAW JSON - NO MARKDOWN, NO BACKTICKS, NO EXPLANATION.
Use this exact structure:
{"note":"full note text here","audit":[{"item":"Medical necessity","status":"ok","note":"Clearly documented"},{"item":"Functional impairment","status":"warn","note":"Could be more specific"},{"item":"Treatment modality","status":"ok","note":"CBT noted"},{"item":"Progress toward goals","status":"ok","note":"Documented"},{"item":"Risk assessment","status":"fail","note":"SI/HI not addressed"},{"item":"Between-session tasks","status":"ok","note":"Homework assigned"},{"item":"Next session plan","status":"ok","note":"Follow-up noted"}]}

Statuses: "ok" = present and clear, "warn" = present but could be stronger, "fail" = missing.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1200 }
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = data?.error?.message || `Gemini error ${geminiRes.status}`;
      return res.status(geminiRes.status).json({ error: msg });
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON from response
    let parsed;
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      const cleaned = raw.slice(start, end + 1);
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: return raw text as note
      parsed = { note: raw, audit: [] };
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Gemini API: ' + err.message });
  }
}
