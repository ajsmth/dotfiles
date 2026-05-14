function fail(message) {
    throw new Error(message);
}
function defaultBackend() {
    const configured = process.env.DEV_LLM_BACKEND ?? process.env.GIT_CHANGE_SUMMARY_BACKEND;
    if (configured === 'openai' || configured === 'ollama') {
        return configured;
    }
    if (process.env.OLLAMA_HOST) {
        return 'ollama';
    }
    return 'openai';
}
function defaultModel(backend) {
    const configured = process.env.DEV_LLM_MODEL ?? process.env.GIT_CHANGE_SUMMARY_MODEL;
    if (configured && configured.trim() !== '') {
        return configured.trim();
    }
    return backend === 'ollama' ? 'qwen2.5-coder:latest' : 'gpt-5-mini';
}
function openaiBaseUrl() {
    return (process.env.DEV_LLM_BASE_URL ??
        process.env.GIT_CHANGE_SUMMARY_BASE_URL ??
        'https://api.openai.com/v1');
}
function openaiApiKey() {
    return (process.env.DEV_LLM_API_KEY ??
        process.env.GIT_CHANGE_SUMMARY_API_KEY ??
        process.env.OPENAI_API_KEY ??
        '').trim();
}
function ollamaHost() {
    return (process.env.DEV_LLM_BASE_URL ??
        process.env.GIT_CHANGE_SUMMARY_BASE_URL ??
        process.env.OLLAMA_HOST ??
        'http://127.0.0.1:11434');
}
async function parseJsonResponse(response, label) {
    const text = await response.text();
    if (!response.ok) {
        fail(`${label} request failed: ${response.status} ${response.statusText}\n${text}`);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`${label} returned invalid JSON: ${message}`);
    }
}
function extractOpenAiText(data) {
    const choices = data.choices;
    const first = choices?.[0];
    const content = first?.message?.content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'object' && part !== null && 'text' in part
            ? String(part.text)
            : ''))
            .join('')
            .trim();
    }
    return typeof content === 'string' ? content.trim() : '';
}
function extractOllamaText(data) {
    const message = data.message;
    return typeof message?.content === 'string' ? message.content.trim() : '';
}
export function stripMarkdownFence(value) {
    const trimmed = value.trim();
    const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return match ? match[1] : value;
}
export async function chat(systemPrompt, userPrompt, options = {}) {
    const backend = options.backend ?? defaultBackend();
    const model = options.model?.trim() || defaultModel(backend);
    if (backend === 'openai') {
        const apiKey = openaiApiKey();
        if (!apiKey) {
            fail('Missing API key. Set DEV_LLM_API_KEY, GIT_CHANGE_SUMMARY_API_KEY, or OPENAI_API_KEY.');
        }
        const data = await parseJsonResponse(await fetch(`${openaiBaseUrl().replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
        }), 'OpenAI-compatible');
        const text = extractOpenAiText(data);
        if (!text) {
            fail('OpenAI-compatible backend returned empty output.');
        }
        return text;
    }
    const data = await parseJsonResponse(await fetch(`${ollamaHost().replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            stream: false,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }),
    }), 'Ollama');
    const text = extractOllamaText(data);
    if (!text) {
        fail('Ollama returned empty output.');
    }
    return text;
}
