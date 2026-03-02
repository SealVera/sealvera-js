/**
 * SealVera SDK — TypeScript declarations
 *
 * AI decision audit logging: log, explain, and cryptographically attest
 * every decision your AI agents make.
 */

// ── Core types ────────────────────────────────────────────────────────

export interface SealVeraConfig {
  /** SealVera server endpoint. Default: http://localhost:3000 */
  endpoint: string;
  /** API key (sv_...) from your org's API Keys settings */
  apiKey: string;
  /** Default agent name for this SDK instance */
  agent?: string;
  /** Enable verbose debug logging */
  debug?: boolean;
}

/** A structured reasoning step — the gold standard of native evidence */
export interface ReasoningStep {
  /** Field name the agent inspected (e.g. "credit_score", "claim_amount") */
  factor: string;
  /** Actual value observed */
  value: string | number | boolean;
  /** Whether this signal pushed toward risk or safety */
  signal: 'risk' | 'safe';
  /** One-sentence explanation of this factor's contribution */
  explanation: string;
}

export interface WrapOptions {
  /** Agent name (overrides SDK default) */
  agent: string;
  /** Human-readable action label (e.g. "evaluate_loan_application") */
  action: string;
  /** Input data to the agent */
  input: Record<string, unknown>;
  /** Function to execute and wrap */
  fn: () => unknown | Promise<unknown>;
  /** Explicit trace ID (auto-propagated inside SealVera.trace()) */
  traceId?: string;
  /** Agent role in multi-step trace (e.g. "fraud-screener", "approver") */
  role?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  agent: string;
  action: string;
  decision: string;
  input: unknown;
  output: unknown;
  reasoning?: string;
  reasoning_steps?: ReasoningStep[] | null;
  evidence_source?: 'native' | 'auto-extract' | null;
  model_used?: string | null;
  trace_id?: string | null;
  trace_role?: string | null;
  attestation_hash?: string;
  attestation_sig?: string;
  org_id?: string;
}

export interface IngestResponse {
  ok: boolean;
  id: string;
  traceId?: string;
  autoTraced?: boolean;
  traceConfidence?: string;
}

export interface TraceContext {
  traceId: string;
  traceName: string;
}

export interface OtelSpanOptions {
  agent?: string;
  action?: string;
  decision?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  reasoning?: string;
  traceId?: string;
}

// ── createClient types ────────────────────────────────────────────────

export interface CreateClientOptions {
  /** Agent name this client will log under */
  agent: string;
}

/**
 * A proxied LLM client that transparently logs every call to SealVera.
 * Use exactly like the original SDK client.
 */
export type AuditedClient<T> = T;

// ── SDK export ────────────────────────────────────────────────────────

export declare const SealVera: {
  /**
   * Initialize the SealVera SDK.
   * Must be called before any other method.
   *
   * @example
   * SealVera.init({ endpoint: 'http://localhost:3000', apiKey: 'sv_...', agent: 'my-agent' });
   */
  init(config: SealVeraConfig): void;

  /**
   * Capture LLM call parameters before invoking the model.
   * Enriches audit logs with the exact params sent to the LLM.
   */
  capture(params: Record<string, unknown>): void;

  /**
   * Wrap an agent function — executes it and logs the input/output/decision.
   *
   * @example
   * const result = await SealVera.wrap({
   *   agent: 'fraud-screener',
   *   action: 'evaluate_transaction',
   *   input: { amount: 5000, userId: 'u_123' },
   *   fn: () => fraudAgent(transaction),
   * });
   */
  wrap<T = unknown>(options: WrapOptions): Promise<T>;

  /**
   * createClient — preferred API for per-agent logging.
   *
   * Pass your configured SDK client. SealVera auto-detects the provider
   * (OpenAI, Anthropic, OpenRouter) and returns a Proxy that logs every
   * call transparently.
   *
   * @example
   * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
   * const agent  = SealVera.createClient(openai, { agent: 'fraud-screener' });
   * // Use `agent` exactly like `openai`:
   * const result = await agent.chat.completions.create({ model: 'gpt-4o', messages });
   */
  createClient<T extends object>(client: T, options: CreateClientOptions): AuditedClient<T>;

  /**
   * Auto-patch an OpenAI client class so every instance logs automatically.
   * @deprecated Prefer createClient() for per-agent control.
   */
  patchOpenAI(OpenAIClass: unknown): void;

  /**
   * Auto-patch an Anthropic client instance so all calls log automatically.
   * @deprecated Prefer createClient() for per-agent control.
   */
  patchAnthropic(client: unknown): void;

  /**
   * Auto-patch an OpenRouter client (OpenAI-compatible) to log all calls.
   * @deprecated Prefer createClient() for per-agent control.
   */
  patchOpenRouter(client: unknown): void;

  /** Auto-patch a Google Gemini GenerativeModel instance. */
  patchGemini(model: unknown): void;

  /** Auto-patch an Ollama client instance. */
  patchOllama(client: unknown): void;

  /**
   * Universal LLM wrapper — works with any provider, no patching needed.
   */
  wrapLLM(options: {
    provider: string;
    agent: string;
    action: string;
    input: unknown;
    fn: () => unknown | Promise<unknown>;
  }): Promise<unknown>;

  /**
   * Low-level: send a log entry directly to SealVera.
   */
  sendLog(entry: Partial<LogEntry>): Promise<IngestResponse>;

  /**
   * Run an async function inside a named trace context.
   * All wrap() and createClient() calls within the function automatically
   * receive the same traceId — no manual threading required.
   *
   * @example
   * await SealVera.trace('claim-C9182', async () => {
   *   await fraudAgent.evaluate(claim);    // auto-tagged traceId=claim-C9182
   *   await underwriter.decide(claim);     // auto-tagged traceId=claim-C9182
   * });
   */
  trace(traceId: string, fn: () => Promise<unknown>): Promise<unknown>;
  trace(fn: () => Promise<unknown>): Promise<unknown>;

  /**
   * Get the currently active trace context (if inside SealVera.trace()).
   * Returns null outside of a trace context.
   */
  _getTraceContext(): TraceContext | null;

  /**
   * Create an OTel-compatible span object for an AI decision.
   * Useful for dual-shipping to SealVera and other OTel backends.
   */
  createOtelSpan(options: OtelSpanOptions): object;
};

export default SealVera;
