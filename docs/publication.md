# Publishing the extension on the Chrome Web Store (unlisted)

Goal: people who have the link install the extension in one click ("Add to Chrome"), sign in with Google, and get 30 AI groupings per day. Without signing in, the extension groups by keywords.

| Step | Who | Time |
|---|---|---|
| 1. Chrome Web Store developer account | you | 5 min, one-time US$5 |
| 2. Draft: get the item ID and its public key | you | 5 min |
| 3. Google consent screen and OAuth client | you | 10 min |
| 4. Configure the extension and the backend | repo | 5 min |
| 5. Listing, privacy, "Unlisted" visibility, submission | you | 20 min, then a few days of review |
| 6. Invite people | you | — |

## 1. Developer account

Open the [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole), accept the agreement and pay the one-time registration fee. The contact address you choose appears on the extension's listing.

## 2. Draft: item ID and public key

```powershell
cd extension
npm run package -- --draft   # dist/contexttab-0.1.0-draft.zip
```

1. Dashboard → **New item** → upload this zip. **Do not submit it**: it only serves to reserve the ID.
2. Note the **item ID** (32 letters, visible in the address of the item's page).
3. **Package** tab → **View public key** → copy the key (the text between the `BEGIN` and `END` lines, without those lines).

## 3. Google sign-in

In [Google Auth Platform](https://console.cloud.google.com/auth/overview?project=tab-auto-grouping) (project `tab-auto-grouping`):

1. **Branding**: application name `ContextTab`, support email, link to the privacy policy: `https://tab-classifier-11839059749.europe-west1.run.app/privacy`.
2. **Audience**: type **External**. Leave the state as **Testing** and add, under **Test users**, the Gmail address of each invited person (100 at most), including yours. Only these people will be able to sign in. To open it to everyone later: **Publish app** (with the `openid` scope alone, Google normally does not require verification).
3. **Data Access**: add the `openid` scope.
4. **Clients** → **Create client** → type **Chrome extension** → item ID = the one from step 2 → copy the **client ID** (`….apps.googleusercontent.com`).

## 4. Configure the extension and the backend

1. In [extension/manifest.json](../extension/manifest.json), add:

   ```json
   "key": "<public key from step 2>",
   "oauth2": { "client_id": "<client ID from step 3>", "scopes": ["openid"] },
   ```

   The key gives the extension loaded in development the same ID as on the store.
2. Redeploy: `cd backend; npm run deploy`. The script reads the manifest: the API then only accepts this extension (CORS) and Google sign-in is enabled.
3. In `chrome://extensions`, reload the unpacked extension. Its ID changes (it is now the store's ID): settings go back to their defaults. Click **Sign in with Google**, then **Test connection**.
4. Build the final package: `cd extension; npm run package` → `dist/contexttab-0.1.0.zip`. The script refuses to build it while the OAuth client is missing, and removes `key` from the manifest (the store signs with the same key).

## 5. Listing and submission

In the item created in step 2:

- **Package** → **Upload new package** → the final zip.
- **Store listing**: texts below, category *Productivity*, language *English*, icon `extension/icons/icon128.png`, at least one 1280 × 800 screenshot (popup and options page).
- **Privacy practices**: texts below, policy URL: `https://tab-classifier-11839059749.europe-west1.run.app/privacy`.
- **Distribution**: visibility **Unlisted**, all regions.
- **Submit for review.** Review usually takes a few days; the item can be published automatically after approval.

## 6. Inviting people

1. Add their Gmail address under **Test users** (step 3).
2. Send them the listing link (the item's **Copy link** button).
3. On their side: **Add to Chrome** → the options page opens → **Sign in with Google**.

## Updates

Increase `version` in `extension/manifest.json` (for example `0.1.1`), run `npm run package`, upload the zip in the **Package** tab and submit. Chrome updates installed copies on its own.

## Limits and costs

- **30 AI groupings per person per day, 300 in total** (UTC day). Beyond that, the extension groups by keywords until midnight UTC. To change these values: `backend/deploy.config.json`, then `npm run deploy` (0 = unlimited).
- The **owner token** (Secret Manager, `extension-token`) bypasses these limits: keep it to yourself.
- The billing account's budget alert notifies you by email but stops nothing; the global cap, on the other hand, stops calls to Gemini.

---

## Texts to copy into the dashboard

### Short description (132 characters maximum)

> Automatically groups your tabs by topic (shopping, travel, work…) using Gemini AI. One-click undo.

### Detailed description

> Too many tabs open? ContextTab tidies them for you into Chrome tab groups named after their topic: "🚗 Cars", "🍽️ Restaurants", "✈️ Trip to Rome"…
>
> • Automatic: as soon as there are 10 ungrouped tabs in a window, then for every new batch of 3 tabs.
> • Manual if you prefer: "Group now" button or Alt+G shortcut.
> • One-click undo, from the popup or the notification. A tab you remove from a group is not forced back into it.
> • Rename groups from the popup, choose the language of group names, exclude domains (bank, webmail…).
>
> Privacy: only the title, domain and URL path of the relevant tabs are sent, without parameters or page content. Pinned tabs, private browsing and excluded domains are never sent. This data is not kept on the server.
>
> Sign in with your Google account (no name or email is transmitted): 30 AI groupings per day. Without signing in, or beyond the limit, the extension groups by keywords, offline.

### Single purpose

> Automatically group open tabs into Chrome tab groups named after their topic.

### Permission justifications

| Permission | Justification |
|---|---|
| `tabs` | Read the title and address of open tabs to determine their topic, then move them into groups. |
| `tabGroups` | Create, name, color and collapse tab groups; undo a grouping. |
| `storage` | Save settings, a local cache of classifications (24 h) and the history that allows undoing. |
| `alarms` | Respect the minimum delay between two automatic groupings, even after the service worker goes to sleep. |
| `notifications` | Indicate that a grouping took place, with an "Undo" button. |
| `identity` | Google sign-in (`openid` scope only) to apply the online service's per-person daily limit. |
| Host permissions | `*.run.app`: classification service hosted on Google Cloud Run. `localhost`: development server. `generativelanguage.googleapis.com`: optional mode where the user supplies their own Gemini API key. |
| Remote code | "No": all code is in the package; the service only returns JSON data. |

### Data usage

- Types of data collected:
  - **Web history**: titles and addresses (without parameters) of the tabs to group;
  - **Authentication information**: temporary Google access token, verified then forgotten;
  - **Personally identifiable information**: Google account identifier, kept in pseudonymous form with a counter for the day, deleted after 2 to 3 days.

  When in doubt, also tick **Website content** (page titles): declaring more is not penalized, declaring less is.
- Tick all three certifications: no sale to third parties, no use unrelated to the single purpose, no creditworthiness assessment.
