/**
 * SealVeraClient — main client class
 * Handles configuration and exposes all audit logging APIs
 */

const { sendLog, setConfig, getConfig } = require('./http');
const { capture, consume } = require('./capture');
const { patchOpenAI, patchAnthropic, patchGemini, patchOllama, wrapLLM } = require('./interceptor');
const { v4: uuidv4 } = (function() {
  try { return require('uuid'); } catch(_) {
    // Fallback UUID v4 implementation (no dependencies)
    return {
      v4: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      })
    };
  }
})();

// Lazy-load SealVera singleton to get trace context (avoids circular dep)
function _getTraceCtx() {
  try { return require('../index')._getTraceContext(); } catch(_) { return null; }
}

class SealVeraClient {
  constructor() {
    this._initialized = false;
  }

  /**
   * Initialize SealVera SDK
   * @param {object} config
   * @param {string} config.endpoint - SealVera server URL (e.g. http://localhost:3000)
   * @param {string} config.apiKey - API key (starts with sv_)
   * @param {string} [config.agent] - Agent name for all logged calls
   * @param {boolean} [config.debug] - Enable debug logging
   */
  init(config = {}) {
    if (!config.endpoint) throw new Error('[SealVera] endpoint is required');
    if (!config.apiKey) throw new Error('[SealVera] apiKey is required');

    setConfig({
      endpoint: config.endpoint.replace(/\/$/, ''),
      apiKey: config.apiKey,
      agent: config.agent || 'ai-agent',
      debug: config.debug || false
    });

    this._initialized = true;

    if (config.debug) {
      console.log(`[SealVera] Initialized: endpoint=${config.endpoint}, agent=${config.agent || 'ai-agent'}`);
    }

    return this;
  }

  /**
   * Capture OpenAI params before a call (used with wrap())
   * Place this inside your agent function, right before the openai call
   */
  capture(params) {
    capture(params);
    return this;
  }

  /**
   * Wrap an agent function call — logs input/output/decision
   * @param {object} options
   * @param {string} options.agent - Agent name
   * @param {string} options.action - Action being performed
   * @param {*} options.input - Input data
   * @param {Function} options.fn - Async function to run
   * @param {string} [options.traceId] - Optional explicit traceId (overrides context)
   * @param {string} [options.role] - Optional role within the trace
   */
  async wrap({ agent, action, input, fn, traceId, role }) {
    const config = getConfig();
    const agentName = agent || config?.agent || 'ai-agent';
    const startedAt = new Date().toISOString();

    const output = await fn();

    // Extract structured fields
    const decision = output?.decision || output?.action || (
      output?.approved !== undefined ? (output.approved ? 'APPROVED' : 'REJECTED') : 'completed'
    );

    const reasoning_steps = output?.reasoning_steps || null;

    // Pick up trace context from AsyncLocalStorage if available
    const ctx = _getTraceCtx();
    const resolvedTraceId = traceId || (ctx ? ctx.traceId : null);
    const resolvedRole    = role || null;

    const entry = {
      id: uuidv4(),
      timestamp: startedAt,
      agent: agentName,
      action,
      decision,
      input,
      output,
      reasoning: output?.reasoning || '',
      reasoning_steps: reasoning_steps ? JSON.stringify(reasoning_steps) : null,
      raw_context: { agent: agentName, action, input, output },
      traceId: resolvedTraceId || undefined,
      role: resolvedRole || undefined
    };

    try {
      await sendLog(entry);
      if (config?.debug) {
        console.log(`[SealVera] Logged: ${action} → ${decision}${resolvedTraceId ? ` [trace: ${resolvedTraceId}]` : ''}`);
      }
    } catch (err) {
      console.warn('[SealVera] Log send failed (non-fatal):', err.message);
    }

    return output;
  }

  /**
   * Auto-patch OpenAI to log all calls automatically
   */
  patchOpenAI(openaiInstanceOrClass) {
    return patchOpenAI(openaiInstanceOrClass);
  }

  /**
   * Auto-patch Anthropic to log all calls automatically
   */
  patchAnthropic(anthropic) {
    return patchAnthropic(anthropic);
  }

  /**
   * Auto-patch Google Gemini to log all calls automatically
   */
  patchGemini(genAI) {
    return patchGemini(genAI);
  }

  /**
   * Auto-patch Ollama to log all calls automatically
   */
  patchOllama(ollama) {
    return patchOllama(ollama);
  }

  /**
   * Universal LLM wrapper — works with any provider
   */
  async wrapLLM(options) {
    return wrapLLM(options);
  }
}

module.exports = { SealVeraClient };
