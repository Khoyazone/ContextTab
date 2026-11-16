# ContextTab

A Chrome extension (Manifest V3) that automatically groups tabs by **context** ("buying a car", "restaurants", "trip to Rome"…) using **Gemini on Vertex AI**, called through a **Cloud Run** API. No API key is stored in the extension: users sign in with Google and get a limited number of AI groupings per day.

Publishing to the Chrome Web Store (unlisted listing): see [docs/publication.md](docs/publication.md).

Example: 10 open tabs, 4 of them car searches and 6 restaurant searches. The 10th tab triggers the grouping and produces two groups, `🚗 Voitures` and `🍽️ Restaurants`, about 2.5 s later (debounce included).

The original plan is in [plan.md](plan.md). Deviations from that plan are detailed below, with their reasons.

## Quick start (5 min, no cloud)

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the [extension/](extension/) folder. There is no build step.
2. The Options page opens. Pick an engine:
   - **Local heuristic**: works right away, offline, without AI (keywords and domains);
   - **Direct Gemini API** (prototype): paste an AI Studio key. The key stays in this Chrome profile; replace it with the backend before the demo;
   - **Gemini via the online service** (Cloud Run backend): **Sign in with Google** button (see [Google sign-in and daily limit](#google-sign-in-and-daily-limit)), or an owner token under **Advanced settings**.
3. Click **Test connection**, then open 10 tabs. The groups appear; the popup (extension icon) then lets you undo them, ungroup everything or rename them. The `Alt+G` shortcut triggers a manual grouping.

## Running the backend locally

```powershell
cd backend
npm install
Copy-Item .env.example .env   # then edit .env
npm run dev                   # http://localhost:8080 (hot reload, copies the shared core)
```

Two modes, chosen in `.env`:

- **Vertex AI**, as in production: run `gcloud auth application-default login`, then set `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=<id>` and `GOOGLE_CLOUD_LOCATION=eu`;
- **AI Studio key**, for quick testing: remove the `GOOGLE_GENAI_USE_VERTEXAI` line and set `GEMINI_API_KEY`.

Without credentials the server still works: every response then comes from the heuristic, with an `error` field explaining why.

In the extension options, choose **Gemini via the online service**, then under **Advanced settings** enter the URL `http://localhost:8080` and, as the owner token, the value of `EXTENSION_TOKEN` from `.env`. Locally, daily counters stay in memory (`QUOTA_STORE=memory`).

## Deploying to Cloud Run

Prerequisites: [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed (or Cloud Shell) and billing enabled. The scripts are written in Node and work on PowerShell, macOS, Linux and Cloud Shell.

```powershell
cd backend
npm run setup-gcp   # project read from deploy.config.json (or --project <PROJECT_ID>)
npm run deploy
```

- `setup-gcp` is safe to re-run (idempotent). It enables the Vertex AI, Cloud Run, Artifact Registry, Cloud Build, Secret Manager and Firestore APIs. It creates:
  - the `tab-classifier-sa` service account (roles `roles/aiplatform.user` and `roles/datastore.user`);
  - the `extension-token` secret (owner token), replicated in `europe-west1`. **It prints it only once**;
  - the `(default)` Firestore database in `europe-west1` (free tier), with a TTL rule that deletes daily counters after two days.
- `deploy` syncs the core, runs the tests, then runs `gcloud run deploy --source`. Cloud Run runs in `europe-west1`, Vertex AI is called on the `eu` multi-region, with a maximum of 3 instances.
- Every deployment replaces all of the service's environment variables. Persistent values therefore come from files:
  - [backend/deploy.config.json](backend/deploy.config.json): project, daily limits, contact shown on the privacy page;
  - [extension/manifest.json](extension/manifest.json): the allowed origin (extension ID, derived from `key`) and the OAuth client used for Google sign-in (`oauth2.client_id`).

  The `--origin`, `--oauth-client-id`, `--daily-limit`, `--global-daily-limit` and `--contact` options override them for a single deployment.
- If your organization forbids `--allow-unauthenticated` (Domain Restricted Sharing), you need to request an exception: authentication relies on Google sign-in and the owner token.

## Google sign-in and daily limit

- The extension gets a Google access token with `chrome.identity.getAuthToken` (`openid` scope only: no name or email) and sends it in the `X-User-Token` header. `X-Google-…` headers are stripped by the Cloud Run front end, and `Authorization` is intercepted by it.
- The backend verifies the token with Google: it must have been issued for the extension's OAuth client. From it, the backend derives a pseudonymous identifier (SHA-256 hash of the account ID).
- **Limits** ([backend/deploy.config.json](backend/deploy.config.json)): 30 AI groupings per person per UTC day, and 300 in total, counted in Firestore before calling Gemini. Beyond that, the API returns 429 (`code: "daily_limit"`) and the extension groups by keywords until midnight UTC.
- The owner token (`X-Extension-Token`) is not limited: it is reserved for the owner, evaluation and development.
- `GET /me` returns today's usage without counting anything (options page). `GET /privacy` serves the privacy policy ([backend/public/privacy.html](backend/public/privacy.html)).
- Google configuration (consent screen, "Chrome Extension" OAuth client) and publishing are described in [docs/publication.md](docs/publication.md).

## Evaluation (target: at least 90% of tabs correctly classified, under 3 s)

The file [test-data/scenarios.json](test-data/scenarios.json) contains 10 scenarios:

- cars/restaurants demo;
- travel/work;
- studies/shopping;
- homonyms (Python, Java);
- single topic;
- incremental grouping;
- prompt injection;
- same site for two intents;
- isolated tabs;
- multilingual titles.

```powershell
node tools/eval.mjs                                   # baseline: heuristic only (73.8%)
cd backend; npm run eval -- --provider local --runs 3 --verbose   # Gemini through the backend pipeline (.env)
node tools/eval.mjs --provider http --url https://<service>.run.app --token <owner token>
```

The script measures:

- accuracy: one-to-one matching between expected and produced groups;
- the number of groups;
- mean and p95 latency;
- stability across several runs (Rand index);
- whether a prompt injection succeeded, if applicable.

`--min 0.9` returns an error code if the target is not met.

> ⚠️ Gemini has not yet been evaluated under real conditions: the development environment had neither a GCP project nor a key. This is the first thing to do. If latency exceeds 3 s, try `GEMINI_MODEL=gemini-3.5-flash-lite`.

## Tests

```powershell
cd extension; npm test     # 80 tests: core, heuristic, triggering, settings, service worker (fake chrome.*), Google sign-in, store package
cd backend; npm test       # 30 tests: API (auth, CORS, 400/413/429/503, fallback), Google sign-in, daily limits, Firestore, privacy page, configuration, core sync
node tools/e2e-chrome.mjs  # real headless Chrome: auto + incremental grouping, popup, Undo, options
cd extension; npm run package   # dist/contexttab-<version>.zip for the Chrome Web Store (see docs/publication.md)
```

The end-to-end test loads the extension into a temporary profile using the DevTools protocol's `Extensions.loadUnpacked`. It does not touch your Chrome profile and stores its screenshots in `tools/e2e-output/`.

## Architecture

```
extension/                      loaded as-is by Chrome (ES modules, no build)
  manifest.json                 MV3: tabs, tabGroups, storage, alarms, notifications; incognito disallowed
  src/core/                     ★ core shared with the backend (single source, no chrome.* or Node)
    request.js · prompt.js · schema.js · validate.js · heuristic.js · pipeline.js · geminiRest.js · thinking.js
  src/shared/                   settings, search-query extraction, eligibility, threshold logic
  src/background/               service worker: events, debounce, execution, cache, undo, notifications
  src/popup/  src/options/      UI (FR, light/dark theme)
  tests/                        node:test + fake chrome.* (helpers/fakeChrome.js)
backend/                        Cloud Run (Express 5, @google/genai 2.31)
  src/app.js · server.js · gemini.js · security.js · config.js · logger.js
  src/core/                     GENERATED copy of extension/src/core (npm run sync-core): do not edit
  scripts/                      sync-core, setup-gcp, deploy
tools/                          eval.mjs (evaluation), e2e-chrome.mjs (end-to-end test)
test-data/scenarios.json
```

Flow of a run:

1. `tabs.*` events trigger a 2.5 s debounce.
2. The service worker counts the window's new ungrouped tabs and compares them to the threshold (10 at first, then 3 once the window has groups). A minimum delay of 30 s separates two runs, handled by `chrome.alarms`.
3. The request is minimized: title, domain, URL path and search query.
4. It goes to `POST /classify`, or directly to Gemini, or to the local heuristic.
5. The response is validated.
6. The extension calls `chrome.tabs.group` and `chrome.tabGroups.update`, then records the history for **Undo**, updates the badge and shows a notification with an "Undo" button.

On the server side, processing follows these steps:

1. Request validation and truncation.
2. Tab IDs are replaced by 1…N: Chrome IDs never reach the model.
3. Call to Gemini with `responseJsonSchema` and a maximum timeout of 8 s.
4. Strict validation of the response:
   - unknown or duplicate IDs are removed;
   - a new group must contain at least 2 tabs;
   - number of groups capped at `maxGroups`;
   - colors must be valid and distinct;
   - an existing group is matched by name if the model recreated it.
5. On failure: one retry, then fallback to the heuristic.

## Technical choices and deviations from the plan

| Topic | Plan | Implemented | Reason |
|---|---|---|---|
| Model | "Gemini Flash, the latest" | `gemini-3.8-flash` (GA), configurable via `GEMINI_MODEL` | `gemini-2.5-flash` was removed from Vertex AI in October 2026; `gemini-3.6-flash` will be retired on November 19, 2026. |
| Region | `europe-west1` | Cloud Run in `europe-west1`, **Vertex AI on the `eu` multi-region** (`aiplatform.eu.rep.googleapis.com`) | Gemini 3.x models are not offered in `europe-west1`; the `eu` multi-region keeps processing within the EU (GDPR). |
| Temperature | 0.1–0.2 | Model default (`GEMINI_TEMPERATURE` to experiment) | Google advises against lowering the temperature on Gemini 3.x, and 3.6 Flash even ignores custom values. Stability comes from the JSON schema, group reuse and caching. |
| Reasoning (thinking) | — | `thinkingLevel: LOW` | For latency: 3.8 Flash does not accept `MINIMAL`. |
| Structured output | `responseSchema` | `responseJsonSchema` (standard JSON Schema) | Same schema for Vertex AI and AI Studio. |
| Language | TypeScript + Vite | JavaScript (ES modules and JSDoc), no build | The "no build for the MVP" option foreseen in the plan: load the extension and it's ready. |
| Backend | Node or Python | Node (Express) | Same language as the extension, hence a shared core (prompt, validation, heuristic). |
| Open questions | §13 | Threshold **per window**; all unpinned tabs are eligible | Proposals from the plan were adopted. |
| Respecting user choices | — | A tab the user removes from a group, or whose grouping was undone, is no longer grouped automatically (unless manually requested) | Avoid "fighting" the user. |

## Privacy

- **Sent for each tab:**
  - the title, limited to 150 characters;
  - the domain;
  - the URL path, **without parameters or fragment**. Long IDs, emails and UUIDs are masked: Google Docs IDs, password-reset links, etc.;
  - the search query, if any.

  Page content is never sent.
- **Never sent:**
  - pinned tabs;
  - private browsing (`"incognito": "not_allowed"`);
  - `chrome://` and `about:` pages;
  - excluded domains, defined in the options.
- Titles are treated as **untrusted data**: they are tagged and escaped in the prompt, the output is validated server-side, and the injection scenario is part of the evaluation.
- The server never logs titles or URLs: only counters, latency and errors.
- **Google account**: `openid` scope only. Firestore only holds a pseudonymous identifier, the date and one counter per person per day, automatically deleted (TTL) after 2 to 3 days.
- Public privacy policy (French and English): `GET /privacy` on the backend, for example `https://tab-classifier-11839059749.europe-west1.run.app/privacy`.

## Known limitations and next steps

- Gemini still needs to be evaluated under real conditions with `npm run eval` (see above), then the prompt needs tuning ([extension/src/core/prompt.js](extension/src/core/prompt.js)).
- Google sign-in relies on `chrome.identity.getAuthToken`, which is Chrome-specific: in Edge or Brave, use the local heuristic or a Gemini key.
- Per-minute rate limiting is in memory, per instance, and bounded by `--max-instances`; daily limits, on the other hand, are global (Firestore).
- The `https://*.run.app/*` host permission covers all Cloud Run services: it can be narrowed to the service's URL once the final address is known.
- Out of MVP scope: meta description (`scripting`), server-side cache (Firestore), embeddings, local Gemini Nano.
