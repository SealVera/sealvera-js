/**
 * SealVera capture helper — stores OpenAI params before an LLM call
 * for enriched audit logging.
 *
 * Usage:
 *   SealVera.capture(params);  // inside your agent, before openai call
 */

let _captured = null;

function capture(params) {
  _captured = params;
}

function consume() {
  const val = _captured;
  _captured = null;
  return val;
}

function peek() {
  return _captured;
}

module.exports = { capture, consume, peek };
