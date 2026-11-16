// Classification providers: Cloud Run backend (production), direct Gemini API (prototype),
// local heuristic (offline). Network failures fall back to the heuristic so grouping still works.
// Backend credentials: the owner token when one is set (no daily limit), otherwise Google sign-in.
import {
  callGeminiApi,
  classifyHeuristically,
  contextFromRequest,
  errorMessage,
  normalizeClassification,
  normalizeClassifyRequest,
  runClassification,
} from '../core/index.js';
import { dropGoogleToken, getGoogleToken, isGoogleSignInAvailable } from '../shared/auth.js';
import { formatTime } from '../shared/format.js';
import { lookupCachedClassification, storeClassification } from './cache.js';

// The backend allows 8 s per Gemini attempt plus one retry.
const BACKEND_TIMEOUT_MS = 20000;
const ACCOUNT_TIMEOUT_MS = 8000;
const GEMINI_TIMEOUT_MS = 8000;

class BackendError extends Error {
  constructor(message, { status = 0, code = '', data = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function describeFailure(status, code, data) {
  switch (code) {
    case 'auth_required':
      return 'not signed in to Google';
    case 'invalid_google_token':
      return 'Google session expired, please sign in again';
    case 'google_signin_disabled':
      return 'Google sign-in is not enabled on this backend';
    case 'daily_limit':
      return data?.scope === 'global'
        ? `service daily capacity reached, until ${formatTime(data?.quota?.resetAt)}`
        : `daily limit reached (${data?.quota?.limit ?? '?'} AI groupings per day), until ${formatTime(data?.quota?.resetAt)}`;
  }
  if (status === 401 || status === 403) return `token rejected (HTTP ${status})`;
  if (status === 429) return 'too many requests, try again in a minute';
  return `HTTP ${status}${data?.error ? `: ${data.error}` : ''}`;
}

async function requestJson(url, { method = 'POST', body, headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      // Custom headers, not "Authorization: Bearer": Cloud Run's front end would try to validate it.
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof data?.code === 'string' ? data.code : '';
      throw new BackendError(describeFailure(response.status, code, data), { status: response.status, code, data });
    }
    if (!data || typeof data !== 'object') throw new Error('invalid JSON response');
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${timeoutMs / 1000} s timeout exceeded`);
    if (error instanceof TypeError) throw new Error('server unreachable (check the URL, backend, and CORS)');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function backendCredentials(settings) {
  if (settings.backendToken) return { kind: 'owner', headers: { 'X-Extension-Token': settings.backendToken } };
  const token = await getGoogleToken();
  return token ? { kind: 'google', token, headers: { 'X-User-Token': token } } : null;
}

/** Calls the backend with the best credentials; a Google token it refuses is replaced once, silently. */
async function callBackend(settings, path, init) {
  let credentials = await backendCredentials(settings);
  if (!credentials) {
    throw isGoogleSignInAvailable()
      ? new BackendError('not signed in to Google', { code: 'not_signed_in' })
      : new BackendError('Google sign-in is unavailable in this version (owner token required)', { code: 'signin_unavailable' });
  }
  const url = `${settings.backendUrl}${path}`;
  try {
    return { data: await requestJson(url, { ...init, headers: credentials.headers }), kind: credentials.kind };
  } catch (error) {
    if (credentials.kind !== 'google' || error?.code !== 'invalid_google_token') throw error;
    await dropGoogleToken(credentials.token);
    credentials = await backendCredentials(settings);
    if (credentials?.kind !== 'google') throw error;
    return { data: await requestJson(url, { ...init, headers: credentials.headers }), kind: credentials.kind };
  }
}

function sanitizeQuota(quota) {
  if (!quota || typeof quota !== 'object') return undefined;
  const { used, limit, remaining, resetAt } = quota;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined;
  return { used, limit, remaining: Number.isFinite(remaining) ? remaining : Math.max(limit - used, 0), resetAt: String(resetAt ?? '') };
}

function fallbackWarning(error) {
  switch (error?.code) {
    case 'not_signed_in':
    case 'auth_required':
      return 'Not signed in: grouping by keywords. Sign in with Google to enable AI.';
    case 'signin_unavailable':
      return 'Google sign-in is unavailable in this version: grouping by keywords.';
    case 'invalid_google_token':
      return 'Google session expired: sign in again in Settings. Grouping by keywords for now.';
    case 'daily_limit':
      return error.data?.scope === 'global'
        ? `Service daily capacity reached: keywords until ${formatTime(error.data?.quota?.resetAt)}.`
        : `Daily limit reached (${error.data?.quota?.limit ?? '?'} AI groupings per day): keywords until ${formatTime(error.data?.quota?.resetAt)}.`;
    default:
      return `Backend injoignable (${errorMessage(error)}) : repli heuristique local.`;
  }
}

async function viaBackend(request, settings, fallback) {
  try {
    const { data } = await callBackend(settings, '/classify', { method: 'POST', body: request, timeoutMs: BACKEND_TIMEOUT_MS });
    // Never trust the network blindly: same validation as for a raw model answer.
    const validated = normalizeClassification(data, contextFromRequest(request));
    const serverFallback = data.source === 'heuristic';
    return {
      ...validated,
      source: serverFallback ? 'heuristic' : 'gemini',
      model: typeof data.model === 'string' ? data.model : undefined,
      quota: sanitizeQuota(data.quota),
      warning: serverFallback && data.error ? `Gemini unavailable on the server (${data.error}): using the local heuristic.` : undefined,
    };
  } catch (error) {
    if (!fallback) throw error;
    return { ...classifyHeuristically(request), source: 'heuristic', warning: fallbackWarning(error) };
  }
}

async function viaGemini(request, settings, fallback) {
  const result = await runClassification(request, {
    generate: (input) =>
      callGeminiApi({ apiKey: settings.geminiApiKey, model: settings.geminiModel, input, timeoutMs: GEMINI_TIMEOUT_MS }),
    retries: 1,
    fallback,
  });
  return {
    ...result,
    model: settings.geminiModel,
    warning: result.source === 'heuristic' ? `Gemini indisponible (${result.error}) : repli heuristique.` : undefined,
  };
}

/**
 * Who the backend sees.
 * @param {object} settings sanitised settings
 * @param {{checkBackend?: boolean}} [options] false: no network call (popup)
 * @returns {Promise<{ok: boolean, mode: 'owner'|'google'|'signed-out'|'unavailable', quota?: object, message?: string}>}
 */
export async function describeAccount(settings, { checkBackend = true } = {}) {
  const credentials = await backendCredentials(settings);
  if (!credentials) return { ok: true, mode: isGoogleSignInAvailable() ? 'signed-out' : 'unavailable' };
  if (!checkBackend) return { ok: true, mode: credentials.kind };
  try {
    const { data, kind } = await callBackend(settings, '/me', { method: 'GET', timeoutMs: ACCOUNT_TIMEOUT_MS });
    return { ok: true, mode: kind, quota: sanitizeQuota(data.quota) };
  } catch (error) {
    return { ok: false, mode: credentials.kind, message: errorMessage(error) };
  }
}

/**
 * @param {object} rawRequest {tabs, existingGroups, language, maxGroups}
 * @param {object} settings sanitised settings
 * @param {{useCache?: boolean, fallback?: boolean}} [options]
 * @returns {Promise<{groups: object[], ungrouped: number[], source: 'gemini'|'heuristic'|'cache',
 *                    model?: string, quota?: object, latencyMs: number, warning?: string}>}
 */
export async function classifyTabs(rawRequest, settings, { useCache = settings.cacheEnabled, fallback = true } = {}) {
  const started = Date.now();
  const request = normalizeClassifyRequest(rawRequest);

  if (useCache && settings.provider !== 'heuristic') {
    const cached = await lookupCachedClassification(request).catch(() => null);
    if (cached) {
      return { ...normalizeClassification(cached, contextFromRequest(request)), source: 'cache', latencyMs: Date.now() - started };
    }
  }

  let result;
  if (settings.provider === 'backend') result = await viaBackend(request, settings, fallback);
  else if (settings.provider === 'gemini') result = await viaGemini(request, settings, fallback);
  else result = { ...classifyHeuristically(request), source: 'heuristic' };

  if (useCache && result.source === 'gemini') await storeClassification(request, result).catch(() => undefined);
  return { ...result, latencyMs: Date.now() - started };
}
