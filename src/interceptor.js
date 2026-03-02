/**
 * SealVera interceptors — auto-patch LLM clients to log all calls
 * Supports: OpenAI, Anthropic Claude, Google Gemini, Ollama
 */

const { sendLog } = require('./http');
const { consume } = require('./capture');
const { getConfig } = require('./http');

// Track patched instances to avoid double-patching
const _patched = new WeakSet();

// Lazy-load SealVera singleton to get trace context (avoids circular dep)
function _getTraceCtx() {
  try { return require('../index')._getTraceContext(); } catch(_) { return null; }
}

/**
 * Extract a decision label from LLM output text.
 *
 * Tries JSON parsing first so structured responses (json_object mode,
 * OpenRouter, Anthropic) have their 'decision' field pulled directly.
 * Falls back to keyword scan for plain-text responses.
 */
function _inferDecision(text) {
  if (!text) return 'completed';

  // 1. Try JSON parse — covers json_object mode and structured outputs
  const stripped = text.trim();
  if (stripped.startsWith('{')) {
    try {
      const parsed = JSON.parse(stripped);
      if (typeof parsed.decision === 'string' && parsed.decision) {
        return parsed.decision.toUpperCase();
      }
    } catch (_) {}
  }

  // 2. Keyword scan for plain-text responses (order matters — most specific first)
  const upper = text.toUpperCase();
  const keywords = [
    ['APPROVED',       'APPROVED'],
    ['DENIED',         'DENIED'],
    ['REJECTED',       'REJECTED'],
    ['FLAGGED',        'FLAGGED'],
    ['PENDING_REVIEW', 'PENDING_REVIEW'],
    ['FAST_TRACK',     'FAST_TRACK'],
    ['HIGH_RISK',      'HIGH_RISK'],
    ['CONDITIONAL',    'CONDITIONAL'],
    ['ALLOWED',        'APPROVED'],
    ['BLOCKED',        'REJECTED'],
    ['CLEARED',        'APPROVED'],
  ];
  for (const [kw, label] of keywords) {
    if (upper.includes(kw)) return label;
  }

  return 'completed';
}

/**
 * Extract action label from OpenAI params
 */
function _inferAction(params) {
  if (params.tools && params.tools.length > 0) {
    return params.tools.map(t => t.function?.name || t.name).join(', ');
  }
  const lastMsg = params.messages && params.messages[params.messages.length - 1];
  if (lastMsg && lastMsg.content) {
    const words = String(lastMsg.content).split(' ').slice(0, 6).join(' ');
    return words.length > 40 ? words.slice(0, 40) + '…' : words;
  }
  return 'llm_call';
}

/**
 * Send a log entry (non-fatal, swallows errors).
 * Automatically picks up trace context from AsyncLocalStorage if entry has no traceId.
 */
async function _log(entry) {
  try {
    // Pick up active trace context if not already set
    if (!entry.traceId) {
      const ctx = _getTraceCtx();
      if (ctx) {
        entry = { ...entry, traceId: ctx.traceId };
      }
    }
    await sendLog(entry);
    const config = getConfig();
    if (config?.debug) {
      console.log(`[SealVera] Logged: ${entry.action} → ${entry.decision}${entry.traceId ? ` [trace: ${entry.traceId}]` : ''}`);
    }
  } catch (err) {
    // Non-fatal
    if (getConfig()?.debug) {
      console.warn('[SealVera] Log send failed (non-fatal):', err.message);
    }
  }
}

/**
 * Patch OpenAI SDK instance or class
 * Works with both `new OpenAI()` instances and the OpenAI class itself
 */
function patchOpenAI(openaiInstanceOrClass) {
  const config = getConfig();
  if (!config) throw new Error('[SealVera] Call SealVera.init() before patchOpenAI()');

  try {
    // Support both instance and class
    let instance;
    if (typeof openaiInstanceOrClass === 'function') {
      // It's the class — create a temp instance
      instance = new openaiInstanceOrClass({ apiKey: 'dummy' });
    } else {
      instance = openaiInstanceOrClass;
    }

    const CompletionsProto = Object.getPrototypeOf(instance.chat.completions);
    if (!CompletionsProto || !CompletionsProto.create) {
      console.warn('[SealVera] Could not find chat.completions.create to patch');
      return;
    }

    if (_patched.has(CompletionsProto)) return; // already patched
    _patched.add(CompletionsProto);

    const orig = CompletionsProto.create;
    CompletionsProto.create = async function (...args) {
      const params = args[0] || {};
      const startedAt = new Date().toISOString();
      const response = await orig.apply(this, args);

      if (response && response.choices) {
        setImmediate(async () => {
          const choice = response.choices[0];
          const content = choice.message?.content || '';
          const capturedParams = consume();

          await _log({
            timestamp: startedAt,
            agent: config.agent || 'ai-agent',
            action: _inferAction(params),
            decision: _inferDecision(content),
            input: { messages: params.messages, tools: params.tools, model: params.model },
            output: {
              content,
              tool_calls: choice.message?.tool_calls || [],
              model: response.model,
              usage: response.usage
            },
            reasoning: '',
            raw_context: capturedParams ? { params, capturedParams } : { params },
            provider: 'openai'
          });
        });
      }

      return response;
    };

    console.log('[SealVera] ✓ Patched openai.chat.completions.create');
  } catch (e) {
    console.error('[SealVera] Failed to patch OpenAI:', e.message);
  }
}

/**
 * Parse an Anthropic thinking block into reasoning_steps (if structured) or raw reasoning.
 * Returns { reasoning_steps, reasoning, evidence_source }
 */
function _parseThinkingBlock(thinkingText) {
  if (!thinkingText) return { reasoning_steps: null, reasoning: '', evidence_source: null };

  // Strip XML <thinking> tags (OpenRouter wraps thinking this way)
  let text = thinkingText.replace(/<\/?thinking>/gi, '').trim();

  // Pattern 1: "Factor: ..., Value: ..., Signal: ..."
  const factorPattern = /Factor:\s*([^,\n]+)[,\n]\s*Value:\s*([^,\n]+)[,\n]\s*Signal:\s*([^\n,]+)/gi;
  const structured = [...text.matchAll(factorPattern)];
  if (structured.length >= 2) {
    return {
      reasoning_steps: structured.map(m => ({
        factor: m[1].trim(), value: m[2].trim(),
        signal: m[3].trim().toLowerCase().replace(/[^a-z]/g,'') === 'risk' ? 'risk' : 'safe',
        explanation: 'Extracted from model reasoning chain'
      })),
      reasoning: text.slice(0, 500), evidence_source: 'native'
    };
  }

  // Pattern 2: JSON reasoning_steps embedded in thinking
  const jsonMatch = text.match(/reasoning_steps["\s:]+(\[[\s\S]*?\])/);
  if (jsonMatch) {
    try {
      const steps = JSON.parse(jsonMatch[1]);
      if (Array.isArray(steps) && steps.length > 0)
        return { reasoning_steps: steps, reasoning: text.slice(0, 500), evidence_source: 'native' };
    } catch(_) {}
  }

  // Pattern 3: Bulleted key considerations
  const bulletPattern = /(?:^|\n)\s*[-*•\d.]+\s+([^:\n]+):\s*([^\n→]+?)(?:\s*[→>]\s*(risk|safe|flag))?/gi;
  const bullets = [...text.matchAll(bulletPattern)].slice(0, 6);
  if (bullets.length >= 2) {
    return {
      reasoning_steps: bullets.map(m => ({
        factor: m[1].trim(), value: m[2].trim(),
        signal: (m[3]||'').toLowerCase() === 'risk' ? 'risk' : 'safe',
        explanation: 'Extracted from model reasoning chain'
      })),
      reasoning: text.slice(0, 500), evidence_source: 'native'
    };
  }

  // Fallback: raw thinking as reasoning text
  return { reasoning_steps: null, reasoning: text.slice(0, 2000), evidence_source: 'native' };
}

/**
 * Patch Anthropic SDK instance
 * Intercepts anthropic.messages.create
 * Extracts thinking blocks as native evidence when extended thinking is enabled.
 */
function patchAnthropic(anthropic) {
  const config = getConfig();
  if (!config) throw new Error('[SealVera] Call SealVera.init() before patchAnthropic()');

  if (_patched.has(anthropic)) return;
  _patched.add(anthropic);

  const MessagesProto = Object.getPrototypeOf(anthropic.messages);
  const orig = MessagesProto?.create || anthropic.messages.create;

  if (!orig) {
    console.warn('[SealVera] Could not find anthropic.messages.create to patch');
    return;
  }

  const origFn = orig.bind(anthropic.messages);

  if (MessagesProto) {
    MessagesProto.create = async function (...args) {
      const params = args[0] || {};
      const startedAt = new Date().toISOString();
      const response = await origFn.apply(this, args);

      setImmediate(async () => {
        // Find thinking blocks and text blocks
        let thinkingText = null;
        let textContent = '';

        if (Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'thinking') {
              thinkingText = block.thinking || '';
            } else if (block.type === 'text') {
              textContent = block.text || '';
            }
          }
        } else {
          // Fallback for non-array content
          textContent = response.content?.[0]?.text || '';
        }

        // Parse thinking block if present
        let reasoning = '';
        let reasoning_steps = null;
        let evidence_source = null;

        if (thinkingText) {
          const parsed = _parseThinkingBlock(thinkingText);
          reasoning = parsed.reasoning;
          reasoning_steps = parsed.reasoning_steps;
          evidence_source = parsed.evidence_source; // 'native'
        }

        const model_used = response.model || params.model || null;

        await _log({
          timestamp: startedAt,
          agent: config.agent || 'ai-agent',
          action: params.system?.split(' ').slice(0, 6).join(' ') || 'anthropic_call',
          decision: _inferDecision(textContent),
          input: { messages: params.messages, system: params.system, model: params.model },
          output: { content: textContent, model: response.model, usage: response.usage },
          reasoning,
          reasoning_steps,
          evidence_source,
          model_used,
          raw_context: { params, response_type: 'anthropic', has_thinking: !!thinkingText },
          provider: 'anthropic'
        });
      });

      return response;
    };
  }

  console.log('[SealVera] ✓ Patched anthropic.messages.create (thinking block support enabled)');
}

/**
 * Patch an OpenAI-compatible client configured for OpenRouter.
 *
 * OpenRouter routes to many models. We detect the actual model from response.model
 * and apply appropriate extraction. Claude models with thinking blocks get native evidence.
 */
function patchOpenRouter(openaiCompatibleClient, opts = {}) {
  const config = getConfig();
  if (!config) throw new Error('[SealVera] Call SealVera.init() before patchOpenRouter()');

  const agentName = opts.agent || config.agent || 'ai-agent';

  try {
    let instance;
    if (typeof openaiCompatibleClient === 'function') {
      instance = new openaiCompatibleClient({ apiKey: 'dummy' });
    } else {
      instance = openaiCompatibleClient;
    }

    const CompletionsProto = Object.getPrototypeOf(instance.chat.completions);
    if (!CompletionsProto || !CompletionsProto.create) {
      console.warn('[SealVera] Could not find chat.completions.create to patch for OpenRouter');
      return;
    }

    if (_patched.has(CompletionsProto)) return;
    _patched.add(CompletionsProto);

    const orig = CompletionsProto.create;
    CompletionsProto.create = async function (...args) {
      const params = args[0] || {};
      const startedAt = new Date().toISOString();
      const response = await orig.apply(this, args);

      if (response && response.choices) {
        setImmediate(async () => {
          const choice = response.choices[0];
          const content = choice.message?.content || '';
          const capturedParams = consume();
          const modelUsed = response.model || params.model || 'unknown';

          // Check for thinking blocks in Claude responses via OpenRouter
          let reasoning = '';
          let reasoning_steps = null;
          let evidence_source = null;

          if (modelUsed.toLowerCase().includes('claude')) {
            // Check for <thinking> tags in content (some OpenRouter Claude responses)
            const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/antml:thinking>/i);
            if (thinkingMatch) {
              const parsed = _parseThinkingBlock(thinkingMatch[1]);
              reasoning = parsed.reasoning;
              reasoning_steps = parsed.reasoning_steps;
              evidence_source = parsed.evidence_source;
            }
          }

          await _log({
            timestamp: startedAt,
            agent: agentName,
            action: _inferAction(params),
            decision: _inferDecision(content),
            input: { messages: params.messages, tools: params.tools, model: params.model },
            output: {
              content: evidence_source ? content.replace(/<thinking>[\s\S]*?<\/antml:thinking>/i, '').trim() : content,
              tool_calls: choice.message?.tool_calls || [],
              model: modelUsed,
              usage: response.usage
            },
            reasoning,
            reasoning_steps,
            evidence_source,
            model_used: modelUsed,
            raw_context: capturedParams
              ? { params, capturedParams, response_type: 'openrouter', model_used: modelUsed }
              : { params, response_type: 'openrouter', model_used: modelUsed },
            provider: 'openrouter'
          });
        });
      }

      return response;
    };

    console.log('[SealVera] ✓ Patched OpenRouter client (openai-compatible)');
  } catch (e) {
    console.error('[SealVera] Failed to patch OpenRouter:', e.message);
  }
}

/**
 * Patch Google Generative AI (Gemini) model
 * Usage: SealVera.patchGemini(genAI) where genAI = new GoogleGenerativeAI(apiKey)
 * Or: SealVera.patchGemini(model) where model = genAI.getGenerativeModel(...)
 */
function patchGemini(genAIOrModel) {
  const config = getConfig();
  if (!config) throw new Error('[SealVera] Call SealVera.init() before patchGemini()');

  if (_patched.has(genAIOrModel)) return;
  _patched.add(genAIOrModel);

  // Support both the genAI client and a model instance
  if (typeof genAIOrModel.getGenerativeModel === 'function') {
    // It's the genAI client — patch getGenerativeModel to auto-patch each model
    const origGetModel = genAIOrModel.getGenerativeModel.bind(genAIOrModel);
    genAIOrModel.getGenerativeModel = function (...args) {
      const model = origGetModel(...args);
      patchGemini(model); // recursively patch the model
      return model;
    };
    console.log('[SealVera] ✓ Patched GoogleGenerativeAI.getGenerativeModel (Gemini)');
    return;
  }

  // It's a model instance — patch generateContent
  if (typeof genAIOrModel.generateContent !== 'function') {
    console.warn('[SealVera] Could not find generateContent to patch on Gemini model');
    return;
  }

  const orig = genAIOrModel.generateContent.bind(genAIOrModel);
  genAIOrModel.generateContent = async function (...args) {
    const startedAt = new Date().toISOString();
    const response = await orig(...args);

    setImmediate(async () => {
      let text = '';
      try { text = response.response.text(); } catch (_) {}
      const input = args[0];

      await _log({
        timestamp: startedAt,
        agent: config.agent || 'ai-agent',
        action: typeof input === 'string'
          ? input.split(' ').slice(0, 6).join(' ')
          : 'gemini_call',
        decision: _inferDecision(text),
        input: { prompt: input },
        output: { content: text },
        reasoning: '',
        raw_context: { prompt: input, response_type: 'gemini' },
        provider: 'gemini'
      });
    });

    return response;
  };

  console.log('[SealVera] ✓ Patched Gemini model.generateContent');
}

/**
 * Patch Ollama client
 * Usage: SealVera.patchOllama(ollama) where ollama = new Ollama()
 */
function patchOllama(ollama) {
  const config = getConfig();
  if (!config) throw new Error('[SealVera] Call SealVera.init() before patchOllama()');

  if (_patched.has(ollama)) return;
  _patched.add(ollama);

  if (typeof ollama.chat !== 'function') {
    console.warn('[SealVera] Could not find ollama.chat to patch');
    return;
  }

  const orig = ollama.chat.bind(ollama);
  ollama.chat = async function (...args) {
    const params = args[0] || {};
    const startedAt = new Date().toISOString();
    const response = await orig(...args);

    setImmediate(async () => {
      const content = response.message?.content || '';
      await _log({
        timestamp: startedAt,
        agent: config.agent || 'ai-agent',
        action: params.model ? `ollama_${params.model}` : 'ollama_call',
        decision: _inferDecision(content),
        input: { messages: params.messages, model: params.model },
        output: { content, model: params.model },
        reasoning: '',
        raw_context: { params, response_type: 'ollama' },
        provider: 'ollama'
      });
    });

    return response;
  };

  console.log('[SealVera] ✓ Patched ollama.chat');
}

/**
 * Universal LLM wrapper — works with any LLM
 * Usage: await SealVera.wrapLLM({ provider: 'custom', agent, action, input, fn })
 */
async function wrapLLM({ provider = 'custom', agent, action, input, fn }) {
  const config = getConfig();
  const agentName = agent || config?.agent || 'ai-agent';
  const startedAt = new Date().toISOString();

  const output = await fn();

  // Auto-extract text from common response shapes
  let text = '';
  if (typeof output === 'string') text = output;
  else if (output?.content) text = typeof output.content === 'string' ? output.content : JSON.stringify(output.content);
  else if (output?.text) text = output.text;
  else if (output?.message?.content) text = output.message.content;
  else if (output?.choices?.[0]?.message?.content) text = output.choices[0].message.content;
  else text = JSON.stringify(output);

  await _log({
    timestamp: startedAt,
    agent: agentName,
    action: action || 'llm_call',
    decision: _inferDecision(text),
    input,
    output: { content: text, raw: output },
    reasoning: '',
    raw_context: { input, response_type: provider },
    provider
  });

  return output;
}

// ─────────────────────────────────────────────────────────────────────────────
// createClient — auto-detecting per-agent wrapper (the primary SDK API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fingerprint a client instance to determine its SDK type.
 * Returns: 'anthropic' | 'openrouter' | 'openai'
 */
function _detectClientType(client) {
  // Anthropic: has .messages.create, no .chat
  if (
    client.messages &&
    typeof client.messages.create === 'function' &&
    !client.chat
  ) return 'anthropic';

  // OpenRouter: OpenAI-compatible but baseURL points at openrouter.ai
  if (client.chat && client.chat.completions) {
    const baseURL = (
      client.baseURL ||
      client._options?.baseURL ||
      client.baseUrl ||
      ''
    ).toString().toLowerCase();
    if (baseURL.includes('openrouter')) return 'openrouter';
    return 'openai';
  }

  return 'openai'; // fallback
}

/**
 * createClient(client, config) — auto-detecting per-agent wrapper.
 *
 * Pass any supported SDK client. SealVera fingerprints it and applies the right
 * interceptor. Returns a Proxy of the original client — every call is logged
 * under the given agent name, API keys and custom config stay untouched.
 *
 *   SealVera.init({ endpoint: 'https://app.sealvera.com', apiKey: 'sv_...' });
 *
 *   const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *   const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   const openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
 *
 *   const fraud = SealVera.createClient(openai,     { agent: 'fraud-screener' });
 *   const uw    = SealVera.createClient(anthropic,  { agent: 'loan-underwriter' });
 *   const route = SealVera.createClient(openrouter, { agent: 'router-agent' });
 *
 *   // Use exactly like the original client — every call is now logged
 *   await fraud.chat.completions.create({ model: 'gpt-4o', messages: [...] });
 *   await uw.messages.create({ model: 'claude-3-5-sonnet-20241022', messages: [...] });
 */
function createClient(client, opts = {}) {
  const config = getConfig();
  if (!config) throw new Error('[SealVera] Call SealVera.init() before createClient()');

  const agent       = opts.agent || config.agent || 'ai-agent';
  const clientType  = _detectClientType(client);
  console.log(`[SealVera] createClient: detected ${clientType} SDK for agent "${agent}"`);

  switch (clientType) {
    case 'anthropic':   return _proxyAnthropic(client, agent, config);
    case 'openrouter':  return _proxyOpenRouter(client, agent, config);
    default:            return _proxyOpenAI(client, agent, config);
  }
}

// ── OpenAI proxy ──────────────────────────────────────────────────────────────
function _proxyOpenAI(openaiInstance, agent, config) {
  // Guard: use the instance's own .create unless it's been globally patched.
  // The global patchOpenAI() stores _patched on the prototype; a per-instance
  // proxy should always go through the unpatched original to avoid double-logging.
  const completions   = openaiInstance.chat.completions;
  const isRealSDK     = !!(completions._client); // real openai-go has ._client
  let trueCreate      = completions.create;

  // If the prototype was globally patched, the instance's .create is the wrapper.
  // Retrieve the true original via the WeakMap we maintain in patchOpenAI.
  // For mocked/custom clients, always use the instance's own create directly.
  const proto = Object.getPrototypeOf(completions);
  if (isRealSDK && proto && _patched.has(proto) && proto._sealvera_orig) {
    trueCreate = proto._sealvera_orig;
  }
  const origCreate = trueCreate.bind(completions);

  const wrappedCreate = async function(...args) {
    const params    = args[0] || {};
    const startedAt = new Date().toISOString();
    const response  = await origCreate(...args);

    if (response && response.choices) {
      setImmediate(async () => {
        try {
          const choice  = response.choices[0];
          const content = choice.message?.content || '';
          const model   = response.model || params.model || null;

          // Extract reasoning_steps from JSON response if present
          let reasoning_steps = null; let evidence_source = null;
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed.reasoning_steps)) {
              reasoning_steps = parsed.reasoning_steps;
              evidence_source = 'native';
            }
          } catch (_) {}

          // Parse user message for correlation fields (session_id etc.)
          let userContent = {};
          try {
            const lastUser = [...(params.messages || [])].reverse().find(m => m.role === 'user');
            if (lastUser && typeof lastUser.content === 'string') userContent = JSON.parse(lastUser.content);
          } catch (_) {}

          await _log({
            agent,
            action:          _inferAction(params),
            decision:        _inferDecision(content),
            model:           model,
            model_used:      model,
            input:           { messages: params.messages, tools: params.tools, model: params.model, ...userContent },
            output:          { content, tool_calls: choice.message?.tool_calls || [], model, usage: response.usage },
            reasoning:       '',
            reasoning_steps, evidence_source,
            raw_context:     { params, provider: 'openai' },
            provider:        'openai',
          });
        } catch (err) {
          console.error('[SealVera] createClient OpenAI log error (non-fatal):', err.message);
        }
      });
    }
    return response;
  };

  return new Proxy(openaiInstance, {
    get(target, prop) {
      if (prop !== 'chat') {
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return new Proxy(target.chat, {
        get(chat, chatProp) {
          if (chatProp !== 'completions') {
            const v = chat[chatProp];
            return typeof v === 'function' ? v.bind(chat) : v;
          }
          return new Proxy(chat.completions, {
            get(comp, compProp) {
              if (compProp === 'create') return wrappedCreate;
              const v = comp[compProp];
              return typeof v === 'function' ? v.bind(comp) : v;
            }
          });
        }
      });
    }
  });
}

// ── OpenRouter proxy ──────────────────────────────────────────────────────────
// OpenRouter is OpenAI-compatible — same proxy shape, detects Claude thinking blocks
function _proxyOpenRouter(client, agent, config) {
  const completions = client.chat.completions;
  const origCreate  = completions.create.bind(completions);

  const wrappedCreate = async function(...args) {
    const params    = args[0] || {};
    const startedAt = new Date().toISOString();
    const response  = await origCreate(...args);

    if (response && response.choices) {
      setImmediate(async () => {
        try {
          const choice    = response.choices[0];
          const content   = choice.message?.content || '';
          const modelUsed = response.model || params.model || 'unknown';

          let reasoning = ''; let reasoning_steps = null; let evidence_source = null;

          // Extract reasoning_steps from JSON if present
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed.reasoning_steps)) {
              reasoning_steps = parsed.reasoning_steps;
              evidence_source = 'native';
            }
          } catch (_) {}

          // Claude via OpenRouter: check for <thinking> tags
          if (!reasoning_steps && modelUsed.toLowerCase().includes('claude')) {
            const m = content.match(/<thinking>([\s\S]*?)<\/antml:thinking>/i);
            if (m) {
              const parsed = _parseThinkingBlock(m[1]);
              reasoning = parsed.reasoning; reasoning_steps = parsed.reasoning_steps;
              evidence_source = parsed.evidence_source;
            }
          }

          let userContent = {};
          try {
            const lastUser = [...(params.messages || [])].reverse().find(m => m.role === 'user');
            if (lastUser && typeof lastUser.content === 'string') userContent = JSON.parse(lastUser.content);
          } catch (_) {}

          await _log({
            agent,
            action:          _inferAction(params),
            decision:        _inferDecision(content),
            model:           modelUsed,
            model_used:      modelUsed,
            input:           { messages: params.messages, tools: params.tools, model: params.model, ...userContent },
            output:          { content, tool_calls: choice.message?.tool_calls || [], model: modelUsed, usage: response.usage },
            reasoning, reasoning_steps, evidence_source,
            raw_context:     { params, provider: 'openrouter', model_used: modelUsed },
            provider:        'openrouter',
          });
        } catch (err) {
          console.error('[SealVera] createClient OpenRouter log error (non-fatal):', err.message);
        }
      });
    }
    return response;
  };

  return new Proxy(client, {
    get(target, prop) {
      if (prop !== 'chat') {
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return new Proxy(target.chat, {
        get(chat, chatProp) {
          if (chatProp !== 'completions') {
            const v = chat[chatProp];
            return typeof v === 'function' ? v.bind(chat) : v;
          }
          return new Proxy(chat.completions, {
            get(comp, compProp) {
              if (compProp === 'create') return wrappedCreate;
              const v = comp[compProp];
              return typeof v === 'function' ? v.bind(comp) : v;
            }
          });
        }
      });
    }
  });
}

// ── Anthropic proxy ───────────────────────────────────────────────────────────
function _proxyAnthropic(anthropicInstance, agent, config) {
  const origCreate = anthropicInstance.messages.create.bind(anthropicInstance.messages);

  const wrappedCreate = async function(...args) {
    const params    = args[0] || {};
    const startedAt = new Date().toISOString();
    const response  = await origCreate(...args);

    setImmediate(async () => {
      try {
        let thinkingText = null; let textContent = '';
        if (Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'thinking') thinkingText = block.thinking || '';
            else if (block.type === 'text') textContent = block.text || '';
          }
        }
        if (!textContent && response.content?.[0]) {
          textContent = response.content[0].text || String(response.content[0]);
        }

        let reasoning = ''; let reasoning_steps = null; let evidence_source = null;
        if (thinkingText) {
          const parsed = _parseThinkingBlock(thinkingText);
          reasoning = parsed.reasoning; reasoning_steps = parsed.reasoning_steps;
          evidence_source = parsed.evidence_source;
        }
        if (!reasoning_steps) {
          try {
            const parsed = JSON.parse(textContent);
            if (Array.isArray(parsed.reasoning_steps)) {
              reasoning_steps = parsed.reasoning_steps; evidence_source = 'native';
            }
          } catch (_) {}
        }

        // Decision: try JSON first, then keyword scan
        let decision = null;
        const stripped = textContent.trim();
        if (stripped.startsWith('{')) {
          try {
            const parsed = JSON.parse(stripped);
            if (typeof parsed.decision === 'string') decision = parsed.decision.toUpperCase();
          } catch (_) {}
        }
        if (!decision) decision = _inferDecision(textContent);

        const model  = response.model || null;
        const action = params.system?.split(' ').slice(0, 6).join(' ') || 'anthropic_call';

        let userContent = {};
        try {
          const lastUser = [...(params.messages || [])].reverse().find(m => m.role === 'user');
          if (lastUser && typeof lastUser.content === 'string') userContent = JSON.parse(lastUser.content);
        } catch (_) {}

        await _log({
          agent, action, decision,
          model, model_used: model,
          input:       { messages: params.messages, system: params.system, ...userContent },
          output:      { content: textContent, model, usage: response.usage },
          reasoning, reasoning_steps, evidence_source,
          raw_context: { provider: 'anthropic', has_thinking: !!thinkingText },
          provider:    'anthropic',
        });

        const suffix = thinkingText ? ' [thinking:native]' : '';
        console.log(`[SealVera] Anthropic logged: ${agent} → ${decision}${suffix}`);
      } catch (err) {
        console.error('[SealVera] createClient Anthropic log error (non-fatal):', err.message);
      }
    });

    return response;
  };

  return new Proxy(anthropicInstance, {
    get(target, prop) {
      if (prop !== 'messages') {
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return new Proxy(target.messages, {
        get(msgs, msgProp) {
          if (msgProp === 'create') return wrappedCreate;
          const v = msgs[msgProp];
          return typeof v === 'function' ? v.bind(msgs) : v;
        }
      });
    }
  });
}

module.exports = { patchOpenAI, patchAnthropic, patchGemini, patchOllama, wrapLLM, patchOpenRouter, createClient, _detectClientType };
