// Real LLM call via Groq's OpenAI-compatible API. Falls back to a stubbed response
// with a disclosed artificial delay if GROQ_API_KEY is not set (allowed by the brief).

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

export const usingStub = () => !GROQ_API_KEY;

export async function llmCall(prompt: string, system?: string): Promise<string> {
  if (!GROQ_API_KEY) {
    await new Promise((r) => setTimeout(r, 800)); // disclosed artificial delay
    return `[stubbed LLM — set GROQ_API_KEY for a real call] echo: ${prompt.slice(0, 160)}`;
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}
