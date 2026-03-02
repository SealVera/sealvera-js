/**
 * SealVera SDK — AI Decision Audit Logging
 *
 * Quick start:
 *
 *   const SealVera = require('sealvera');
 *   SealVera.init({ endpoint: 'http://localhost:3000', apiKey: 'sv_...', agent: 'my-agent' });
 *
 *   // Option 1: Auto-patch OpenAI (logs all calls)
 *   const { OpenAI } = require('openai');
 *   SealVera.patchOpenAI(OpenAI);
 *
 *   // Option 2: Wrap agent calls
 *   const result = await SealVera.wrap({
 *     agent: 'payment-agent',
 *     action: 'process_payment',
 *     input: { amount: 1000, customerId: 'c_123' },
 *     fn: () => myPaymentAgent(input)
 *   });
 *
 *   // Option 3: Capture + wrap
 *   SealVera.capture(openaiParams);  // inside agent, before openai call
 *   const result = await SealVera.wrap({ agent, action, input, fn });
 *
 *   // Option 4: Trace context — all calls within get the same traceId
 *   await SealVera.trace('claim-C9182', async () => {
 *     await fraudAgent.evaluate(claim);    // auto-tagged with trace
 *     await underwriter.decide(claim);     // auto-tagged with same trace
 *     await approver.finalize(claim);      // auto-tagged with same trace
 *   });
 */

const { SealVeraClient } = require('./src/client');
const { capture } = require('./src/capture');
const { patchOpenAI, patchAnthropic, patchGemini, patchOllama, wrapLLM, patchOpenRouter, createClient, _detectClientType } = require('./src/interceptor');
const { sendLog } = require('./src/http');

// ── Async context propagation for traces ─────────────────────────────
// Uses AsyncLocalStorage so traceId flows automatically through async calls
// without manual threading.
const { AsyncLocalStorage } = require('async_hooks');
const _traceStorage = new AsyncLocalStorage();

// Singleton client instance
const _client = new SealVeraClient();

// Export a singleton with all methods bound
const SealVera = {
  /**
   * Initialize the SDK
   * @param {object} config - { endpoint, apiKey, agent, debug }
   */
  init: (config) => _client.init(config),

  /**
   * Capture LLM params before a call (enriches audit logs)
   */
  capture,

  /**
   * Wrap an agent function and log the result
   */
  wrap: (options) => _client.wrap(options),

  /**
   * Auto-patch OpenAI client to log all calls
   */
  patchOpenAI,

  /**
   * Auto-patch Anthropic client to log all calls
   */
  patchAnthropic,

  /**
   * Auto-patch Google Gemini client to log all calls
   */
  patchGemini,

  /**
   * Auto-patch Ollama client to log all calls
   */
  patchOllama,

  /**
   * Auto-patch OpenRouter client (OpenAI-compatible) to log all calls
   * Detects actual model from response.model; extracts Claude thinking blocks natively
   */
  patchOpenRouter,

  /**
   * createClient(client, opts) — auto-detecting per-agent wrapper.
   *
   * Pass your already-configured SDK client. SealVera detects the provider
   * automatically and returns a Proxy that logs every call under the given
   * agent name. Supports OpenAI, Anthropic, and OpenRouter.
   *
   * @param {object} client - Configured SDK instance (OpenAI, Anthropic, etc.)
   * @param {object} opts   - { agent: 'my-agent-name' }
   * @returns Proxied client — use exactly like the original
   *
   * @example
   * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
   * const agent  = SealVera.createClient(openai, { agent: 'fraud-screener' });
   * const result = await agent.chat.completions.create({ model: 'gpt-4o', messages: [...] });
   */
  createClient,

  /**
   * Universal LLM wrapper — works with any provider
   */
  wrapLLM,

  /**
   * Low-level: send a log entry directly
   */
  sendLog,

  /**
   * Run fn inside a trace context. All SealVera.wrap() and SealVera.capture()
   * calls made within fn (including nested async calls) automatically get
   * tagged with traceId — no manual traceId threading needed.
   *
   * @param {string|Function} nameOrFn - Trace name/ID string, OR the callback (nameOrFn skipped)
   * @param {Function} [fn] - Async function to run inside the trace context
   * @returns {Promise<*>} — resolves with fn's return value
   *
   * @example
   * await SealVera.trace('process-claim-C9182', async () => {
   *   await fraudAgent.evaluate(claim);    // auto-tagged
   *   await underwriter.decide(claim);     // auto-tagged with same traceId
   * });
   */
  trace: async function(nameOrFn, fn) {
    let traceId, traceName;
    if (typeof nameOrFn === 'function') {
      fn = nameOrFn;
      traceId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      traceName = traceId;
    } else {
      traceId = nameOrFn || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      traceName = traceId;
    }
    return _traceStorage.run({ traceId, traceName }, fn);
  },

  /**
   * Get the currently active trace context (if inside SealVera.trace()).
   * Returns { traceId, traceName } or null.
   * Used internally by wrap() and capture().
   */
  _getTraceContext: function() {
    return _traceStorage.getStore() || null;
  },

  /**
   * Create an OTel-compatible JSON span object for an AI decision.
   * Useful for sending to both SealVera and other OTel backends.
   *
   * @param {object} opts - { agent, action, decision, input, output, model, reasoning, traceId }
   * @returns {object} OTel resourceSpans JSON (ready to POST to /api/otel/v1/spans)
   *
   * @example
   * const span = SealVera.createOtelSpan({ agent: 'fraud-detector', action: 'evaluate', decision: 'FLAGGED', input: {...}, output: {...} });
   * await fetch('http://localhost:3000/api/otel/v1/spans', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SealVera-Key': 'sv_...' }, body: JSON.stringify(span) });
   */
  createOtelSpan: function({ agent, action, decision, input, output, model, reasoning, traceId }) {
    const now = BigInt(Date.now()) * 1000000n; // nanoseconds
    const spanId = Math.random().toString(36).slice(2, 18).padEnd(16, '0');
    const effectiveTraceId = traceId || Math.random().toString(36).slice(2, 34).padEnd(32, '0');

    const attrs = [
      { key: 'ai.agent', value: { stringValue: agent || 'ai-agent' } },
      { key: 'ai.action', value: { stringValue: action || 'evaluate' } },
      { key: 'ai.decision', value: { stringValue: decision || 'completed' } }
    ];
    if (input)    attrs.push({ key: 'ai.input',    value: { stringValue: typeof input === 'string' ? input : JSON.stringify(input) } });
    if (output)   attrs.push({ key: 'ai.output',   value: { stringValue: typeof output === 'string' ? output : JSON.stringify(output) } });
    if (model)    attrs.push({ key: 'ai.model',    value: { stringValue: model } });
    if (reasoning) attrs.push({ key: 'ai.reasoning', value: { stringValue: reasoning } });

    const config = _client._config || {};

    return {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: agent || config.agent || 'ai-agent' } }
          ]
        },
        scopeSpans: [{
          spans: [{
            traceId: effectiveTraceId,
            spanId,
            name: 'ai.decision',
            startTimeUnixNano: now.toString(),
            endTimeUnixNano: (now + 1000000n).toString(),
            attributes: attrs,
            status: { code: 'STATUS_CODE_OK' }
          }]
        }]
      }]
    };
  },

  // Expose the underlying client for advanced usage
  _client
};

module.exports = SealVera;
