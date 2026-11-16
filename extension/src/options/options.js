// Options page: Google account, read / validate / save settings, connection test, cache, shortcut.
import { formatTime } from '../shared/format.js';
import { DEFAULT_SETTINGS, LANGUAGES, loadSettings, normalizeBackendUrl, sanitizeSettings, saveSettings } from '../shared/settings.js';

const form = document.getElementById('settings-form');
const $ = (id) => document.getElementById(id);
const field = (name) => form.elements.namedItem(name);

const VALUE_FIELDS = [
  'backendUrl', 'backendToken', 'geminiApiKey', 'geminiModel', 'threshold',
  'incrementalThreshold', 'minDelaySeconds', 'maxGroups', 'language',
];
const CHECKBOX_FIELDS = ['includeGroupedTabs', 'collapseInactive', 'notify', 'cacheEnabled'];

function setRadio(name, value) {
  for (const input of form.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
}

function getRadio(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value;
}

function updateProviderFields() {
  const provider = getRadio('provider');
  for (const element of form.querySelectorAll('.fields[data-provider]')) {
    element.hidden = element.dataset.provider !== provider;
  }
}

function updateThresholdOutput() {
  $('threshold-value').textContent = field('threshold').value;
}

function fillForm(settings) {
  setRadio('provider', settings.provider);
  setRadio('mode', settings.mode);
  for (const name of VALUE_FIELDS) field(name).value = settings[name];
  for (const name of CHECKBOX_FIELDS) field(name).checked = settings[name];
  field('excludedDomains').value = settings.excludedDomains.join('\n');
  updateThresholdOutput();
  updateProviderFields();
}

function readForm() {
  const values = Object.fromEntries(VALUE_FIELDS.map((name) => [name, field(name).value.trim()]));
  const checks = Object.fromEntries(CHECKBOX_FIELDS.map((name) => [name, field(name).checked]));
  return {
    ...values,
    ...checks,
    provider: getRadio('provider'),
    mode: getRadio('mode'),
    excludedDomains: field('excludedDomains').value.split(/\n+/),
  };
}

function validate(raw) {
  const errors = [];
  const urlValid = Boolean(normalizeBackendUrl(raw.backendUrl));
  field('backendUrl').setAttribute('aria-invalid', String(raw.provider === 'backend' && !urlValid));
  if (raw.provider === 'backend' && !urlValid) errors.push('Invalid backend URL (HTTPS, or HTTP on localhost).');
  if (raw.provider === 'gemini' && !raw.geminiApiKey) errors.push('Gemini API key is missing.');
  return errors;
}

function setSaveStatus(text, state = '') {
  const element = $('save-status');
  element.textContent = text;
  element.dataset.state = state;
}

const ACCOUNT_TEXT = {
  google: ['Signed in with Google', 'AI grouping enabled.'],
  'signed-out': ['Google account', 'Not signed in: tabs are grouped by keywords without sign-in (no AI).'],
  owner: ['Owner token', 'Requests use the owner token (advanced settings); there is no daily limit.'],
  unavailable: ['Google account', 'Google sign-in is unavailable in this extension version: use an owner token or another engine.'],
};

const sentence = (text) => (/[.!?)]$/.test(text) ? text : `${text}.`);

function renderAccount(account) {
  const mode = ACCOUNT_TEXT[account?.mode] ? account.mode : 'signed-out';
  const [title, text] = ACCOUNT_TEXT[mode];
  const details = [];
  if (mode === 'google' && account.quota) {
    const { used, limit, resetAt } = account.quota;
    details.push(`Today: ${used} / ${limit} AI groupings (resets at ${formatTime(resetAt)}).`);
  }
  if (account?.message) details.push(sentence(account.ok === false && mode !== 'signed-out' ? `Problem: ${account.message}` : account.message));
  $('account').dataset.state = account?.ok === false ? 'error' : mode;
  $('account-title').textContent = title;
  $('account-status').textContent = [text, ...details].join(' ');
  $('sign-in').hidden = mode !== 'signed-out';
  $('sign-out').hidden = mode !== 'google';
}

async function refreshAccount() {
  try {
    renderAccount(await chrome.runtime.sendMessage({ type: 'getAccount', settings: sanitizeSettings(readForm()) }));
  } catch (error) {
    renderAccount({ ok: false, mode: 'signed-out', message: error.message });
  }
}

function initAccount(settings) {
  $('privacy-link').href = `${settings.backendUrl}/privacy`;
  $('sign-in').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    $('account-status').textContent = 'Signing in through the Google window…';
    try {
      renderAccount(await chrome.runtime.sendMessage({ type: 'signIn' }));
    } catch {
      await refreshAccount(); // the service worker restarted during the consent: ask again
    } finally {
      button.disabled = false;
    }
  });
  $('sign-out').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      renderAccount(await chrome.runtime.sendMessage({ type: 'signOut' }));
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  for (const name of ['backendUrl', 'backendToken']) field(name).addEventListener('change', refreshAccount);
  window.addEventListener('focus', refreshAccount);
  refreshAccount();
}

async function init() {
  for (const [code, label] of LANGUAGES) $('language').append(new Option(label, code));
  const settings = await loadSettings();
  fillForm(settings);
  initAccount(settings);

  const origin = `chrome-extension://${chrome.runtime.id}`;
  $('extension-origin').textContent = origin;
  $('copy-origin').addEventListener('click', async () => {
    await navigator.clipboard.writeText(origin);
    $('copy-origin').textContent = 'Copied ✓';
  });

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((command) => command.name === 'group-now')?.shortcut;
  $('shortcut').textContent = shortcut || 'not set';
  $('edit-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  form.addEventListener('input', (event) => {
    if (event.target.name === 'threshold') updateThresholdOutput();
    if (event.target.name === 'provider') updateProviderFields();
    setSaveStatus('Unsaved changes.');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = readForm();
    const errors = validate(raw);
    if (errors.length) {
      setSaveStatus(errors.join(' '), 'error');
      return;
    }
    const saved = await saveSettings(raw);
    fillForm(saved); // show the normalised values
    setSaveStatus('Saved ✓', 'ok');
    $('privacy-link').href = `${saved.backendUrl}/privacy`;
    refreshAccount();
  });

  $('reset').addEventListener('click', () => {
    fillForm(sanitizeSettings(DEFAULT_SETTINGS));
    setSaveStatus('Default values loaded: click “Save” to apply them.');
  });

  $('test-provider').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const output = $('test-result');
    const raw = readForm();
    const errors = validate(raw);
    if (errors.length) {
      output.textContent = errors.join(' ');
      output.dataset.state = 'error';
      return;
    }
    button.disabled = true;
    output.textContent = 'Testing…';
    output.dataset.state = '';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'testProvider', settings: sanitizeSettings(raw) });
      const warning = result.message?.startsWith('Attention');
      output.textContent = result.ok || warning ? result.message : `Failed: ${result.message}`;
      output.dataset.state = result.ok ? 'ok' : warning ? 'warn' : 'error';
    } catch (error) {
      output.textContent = `Failed: ${error.message}`;
      output.dataset.state = 'error';
    } finally {
      button.disabled = false;
    }
  });

  $('clear-cache').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'clearCache' });
    setSaveStatus(result?.message ?? 'Cache cleared.', 'ok');
  });
}

init();
