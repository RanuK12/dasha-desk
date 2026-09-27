/**
 * Provider handshake validation.
 *
 * A provider is authenticated by its account-bound token. Everything in the hello
 * frame is still an untrusted capability claim: it is useful for routing and the
 * console, but it is not hardware attestation. Keep the accepted surface small and
 * bounded before any value reaches the registry or a public JSON response.
 */

const HOST_ID = /^[-A-Za-z0-9._]{1,64}$/;
const MODEL_ID = /^[-A-Za-z0-9._/:@+]{1,256}$/;
const SHORT_TEXT = /^[^\u0000-\u001f\u007f]{1,96}$/;
const MAX_MODELS = 32;
// The agent's build is the SHA-256 of the agent.py it runs (see agentfiles.mjs).
const BUILD_HEX = /^[a-f0-9]{64}$/;

export function normalizeModelId(value, field = 'model') {
  if (typeof value !== 'string' || !MODEL_ID.test(value)) {
    throw new TypeError(`${field} may contain only routing-safe characters (256 max)`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !SHORT_TEXT.test(value)) {
    throw new TypeError(`${field} must be printable text no longer than 96 characters`);
  }
  return value;
}

/**
 * Return the only provider fields the gateway accepts. Unknown properties are
 * dropped. `accountId` is never accepted here; the authenticated socket supplies it.
 */
export function normalizeProviderAgent(agent) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new TypeError('agent capabilities must be an object');
  }
  if (typeof agent.id !== 'string' || !HOST_ID.test(agent.id)) {
    throw new TypeError('agent id may contain only letters, numbers, dot, underscore and hyphen (64 max)');
  }
  if (!Array.isArray(agent.models) || agent.models.length < 1 || agent.models.length > MAX_MODELS) {
    throw new TypeError(`models must contain 1-${MAX_MODELS} model ids`);
  }

  const models = [];
  const seen = new Set();
  for (const model of agent.models) {
    const normalized = normalizeModelId(model, 'model ids');
    if (seen.has(normalized)) throw new TypeError(`duplicate model id: ${normalized}`);
    seen.add(normalized);
    models.push(normalized);
  }

  let memoryGb = null;
  if (agent.memory_gb !== undefined && agent.memory_gb !== null) {
    if (!Number.isInteger(agent.memory_gb) || agent.memory_gb < 0 || agent.memory_gb > 4096) {
      throw new TypeError('memory_gb must be an integer between 0 and 4096');
    }
    memoryGb = agent.memory_gb;
  }

  let build = null;
  if (agent.build !== undefined && agent.build !== null && agent.build !== '') {
    if (typeof agent.build !== 'string' || !BUILD_HEX.test(agent.build)) {
      throw new TypeError('build must be a lowercase hex SHA-256 of the agent file');
    }
    build = agent.build;
  }

  // Whether the primary model (the first advertised) is resident right now. Agents
  // that predate the ready bit send nothing, which the gateway keeps as unknown; a
  // present value must be a real boolean, like every other bounded claim here.
  let ready = null;
  if (agent.ready !== undefined && agent.ready !== null) {
    if (typeof agent.ready !== 'boolean') throw new TypeError('ready must be true or false');
    ready = agent.ready;
  }

  return {
    id: agent.id,
    models,
    build,
    chip: optionalText(agent.chip, 'chip'),
    arch: optionalText(agent.arch, 'arch'),
    region: optionalText(agent.region, 'region'),
    runtime: optionalText(agent.runtime, 'runtime'),
    memory_gb: memoryGb,
    ready,
  };
}

/**
 * A provider's `status` frame, sent after hello when residency changes. The only
 * field is the ready bit; anything else on the frame is dropped.
 */
export function normalizeProviderStatus(msg) {
  if (typeof msg?.ready !== 'boolean') throw new TypeError('status.ready must be true or false');
  return { ready: msg.ready };
}
