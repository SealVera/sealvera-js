# SealVera JavaScript SDK

**Tamper-evident audit trails for AI agents — compliance-ready in minutes.**

[![npm version](https://badge.fury.io/js/sealvera.svg)](https://www.npmjs.com/package/sealvera)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org)

SealVera gives every AI decision a cryptographically-sealed, immutable audit log — so you can prove what your agent decided, why it decided it, and that the record hasn't been touched. Built for teams shipping AI in **finance, healthcare, legal, and any regulated industry** that needs to answer to auditors, regulators, or customers.

> **EU AI Act · SOC 2 · HIPAA · GDPR · ISO 42001** — SealVera logs are designed to satisfy the explainability and auditability requirements of major AI compliance frameworks.

---

## Why SealVera?

- **Tamper-evident logs** — every decision is cryptographically hashed and chained; any tampering is detectable
- **2-line integration** — `init()` + `patchOpenAI()` and every LLM call is logged automatically
- **Explainability built-in** — captures inputs, outputs, reasoning, confidence scores, and model used
- **Real-time dashboard** — search, filter, and export your full AI decision history
- **Drift detection** — get alerted when agent behaviour deviates from its baseline
- **Works with any LLM** — OpenAI, Anthropic Claude, Google Gemini, Ollama, LangChain, and more
- **Zero dependencies** — lightweight, no bloat, no vendor lock-in

---

## Installation

```bash
npm install sealvera
```

---

## Quick Start

```javascript
const SealVera = require('sealvera');
const { OpenAI } = require('openai');

// 1. Initialize once (e.g. in your app entry point)
SealVera.init({
 endpoint: 'https://app.sealvera.com',
 apiKey: process.env.SEALVERA_API_KEY,
 agent: 'payment-agent'
});

// 2. Patch your LLM client — all calls are logged automatically
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
SealVera.patchOpenAI(OpenAI);

// 3. Use your LLM normally — nothing else changes
const response = await openai.chat.completions.create({
 model: 'gpt-4o',
 messages: [{ role: 'user', content: 'Should I approve this $5,000 payment?' }]
});
// Decision logged, hashed, and stored in your SealVera audit trail
```

Get your API key at **[app.sealvera.com](https://app.sealvera.com)**.

---

## Supported LLM Providers

| Provider | Method | Auto-patch |
|---|---|---|
| OpenAI (GPT-4o, GPT-4, GPT-3.5) | `patchOpenAI(OpenAI)` | |
| Anthropic Claude | `patchAnthropic(anthropic)` | |
| Google Gemini | `patchGemini(genAI)` | |
| Ollama (local models) | `patchOllama(ollama)` | |
| OpenRouter | `patchOpenRouter(client)` | |
| Any LLM / custom agent | `wrap({ fn })` | |
| LangChain | `SealVeraCallbackHandler` | |

---

## API Reference

### `SealVera.init(config)`

Initialize the SDK. Call once at application startup.

```javascript
SealVera.init({
 endpoint: 'https://app.sealvera.com', // SealVera server URL (required)
 apiKey: 'sv_...', // API key from your dashboard (required)
 agent: 'payment-agent', // Default agent name for all logs
 debug: false // Enable verbose debug logging (optional)
});
```

---

### `SealVera.patchOpenAI(OpenAI)`

Auto-intercept all OpenAI `chat.completions.create` calls. Pass the **class**, not an instance.

```javascript
const { OpenAI } = require('openai');
SealVera.patchOpenAI(OpenAI);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Every call is now automatically audited — model, prompt, response, latency, tokens
const response = await openai.chat.completions.create({
 model: 'gpt-4o',
 messages: [{ role: 'user', content: 'Approve this loan application?' }]
});
```

---

### `SealVera.patchAnthropic(anthropic)`

Auto-intercept all Anthropic Claude calls.

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
SealVera.patchAnthropic(anthropic);

const message = await anthropic.messages.create({
 model: 'claude-3-5-sonnet-20241022',
 max_tokens: 1024,
 messages: [{ role: 'user', content: 'Review this insurance claim.' }]
});
// Logged automatically
```

---

### `SealVera.patchGemini(genAI)`

Auto-intercept all Google Gemini calls.

```javascript
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
SealVera.patchGemini(genAI);

const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
const result = await model.generateContent('Summarise this contract.');
// Logged automatically
```

---

### `SealVera.patchOllama(ollama)`

Auto-intercept local Ollama model calls (Llama, Mistral, Phi, etc.).

```javascript
const { Ollama } = require('ollama');
const ollama = new Ollama();
SealVera.patchOllama(ollama);

const response = await ollama.chat({
 model: 'llama3.2',
 messages: [{ role: 'user', content: 'Classify this support ticket.' }]
});
// Logged automatically — even for on-prem/air-gapped deployments
```

---

### `SealVera.wrap({ agent, action, input, fn })`

Wrap any agent function. Captures input, output, inferred decision, and timing.

```javascript
const result = await SealVera.wrap({
 agent: 'fraud-detector',
 action: 'evaluate_transaction',
 input: { amount: 9800, currency: 'USD', merchant: 'Unknown Corp' },
 fn: async () => {
 // Your agent logic — LLM call, rules engine, ML model, anything
 return { decision: 'FLAGGED', reason: 'Amount near reporting threshold', confidence: 0.91 };
 }
});
// result logged with decision: "FLAGGED"
```

Return a structured object with a `decision` field (`APPROVED`, `REJECTED`, `FLAGGED`) for the richest audit records.

---

### `SealVera.capture(params)`

Pre-capture LLM parameters for enriched logging. Call immediately before your LLM call.

```javascript
const params = {
 model: 'gpt-4o',
 messages: [
 { role: 'system', content: 'You are a compliance review agent...' },
 { role: 'user', content: JSON.stringify(document) }
 ]
};

SealVera.capture(params); // ← one extra line
return await openai.chat.completions.create(params);
```

---

## LangChain Integration

```javascript
const { SealVeraCallbackHandler } = require('sealvera');
const { ChatOpenAI } = require('@langchain/openai');

SealVera.init({ endpoint: 'https://app.sealvera.com', apiKey: process.env.SEALVERA_API_KEY });

const model = new ChatOpenAI({
 modelName: 'gpt-4o',
 callbacks: [new SealVeraCallbackHandler({ agent: 'langchain-agent' })]
});

const response = await model.invoke('Review this contract for compliance risks.');
// Full LangChain chain logged — every step, tool call, and final decision
```

---

## Autoload (Zero-Code Integration)

Add SealVera to any Node.js app without modifying source code:

```bash
node -r sealvera/autoload your-app.js
```

Or in `package.json`:

```json
{
 "scripts": {
 "start": "node -r sealvera/autoload server.js"
 }
}
```

Set via environment variables:

```bash
SEALVERA_ENDPOINT=https://app.sealvera.com
SEALVERA_API_KEY=sv_your_key_here
SEALVERA_AGENT=my-agent
```

---

## Structured Decisions (Recommended)

For the richest audit trail and best compliance posture, return structured decisions from your agents:

```javascript
const result = await SealVera.wrap({
 agent: 'underwriting-agent',
 action: 'evaluate_loan',
 input: application,
 fn: async () => {
 const response = await openai.chat.completions.create({
 model: 'gpt-4o',
 response_format: { type: 'json_object' },
 messages: [{
 role: 'system',
 content: `You are a loan underwriting agent. Evaluate applications and return JSON:
 {
 "decision": "APPROVED" | "REJECTED" | "FLAGGED",
 "reason": "plain-English explanation for the applicant",
 "confidence": 0.0–1.0,
 "risk_factors": ["factor1", "factor2"]
 }`
 }, {
 role: 'user',
 content: JSON.stringify(application)
 }]
 });
 return JSON.parse(response.choices[0].message.content);
 }
});

// result.decision = "APPROVED" | "REJECTED" | "FLAGGED"
// Full record stored in your tamper-evident audit log
```

---

## Use Cases

- **Financial services** — log every credit decision, fraud flag, and payment approval for regulatory review
- **Healthcare AI** — audit trail for clinical decision support tools (HIPAA-aligned)
- **Legal tech** — record document review, contract analysis, and risk assessments
- **Insurance** — log claims triage, underwriting decisions, and anomaly flags
- **HR / hiring tools** — demonstrate fair, explainable AI decisions to avoid bias liability
- **Any agentic AI system** — multi-step reasoning chains, tool calls, and autonomous decisions

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SEALVERA_ENDPOINT` | SealVera server URL | `https://app.sealvera.com` |
| `SEALVERA_API_KEY` | Your API key (starts with `sv_`) | — |
| `SEALVERA_AGENT` | Default agent name | `default` |
| `SEALVERA_DEBUG` | Enable debug logging | `false` |

---

## Self-Hosted

Prefer to keep your data on-prem? SealVera supports self-hosted deployments:

```bash
git clone https://github.com/sealvera/sealvera
cd sealvera && npm install && npm start
```

Then point the SDK at your server:

```javascript
SealVera.init({ endpoint: 'http://your-server:3000', apiKey: 'sv_...' });
```

---

## Links

- **Dashboard & signup** — [app.sealvera.com](https://app.sealvera.com)
- **Full documentation** — [app.sealvera.com/docs](https://app.sealvera.com/docs)
- **Python SDK** — [github.com/sealvera/sealvera-python](https://github.com/sealvera/sealvera-python)
- **Support** — [hello@sealvera.com](mailto:hello@sealvera.com)

---

## License

MIT — see [LICENSE](./LICENSE)
