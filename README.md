# FO Video Upload

A mobile-first web app for field officers (FOs) to upload rig videos from their phones.

- **Google Drive** stores the videos (one sub-folder per category).
- **Google Sheets** is the log (one row per video).
- There is no other database.

Videos go **from the phone straight to Google Drive** using Drive's resumable upload protocol, in 8 MB chunks. They never pass through your server, so serverless body-size limits (e.g. Vercel's) don't matter.

## How it works

1. The FO enters name, Rig IC number and the shared access code (saved in the phone's `localStorage`).
2. They pick a category: Pre Check, Pre Pack, Rig Installation, Post Check, Post Pack or Rig Issue.
3. They choose or record videos, optionally add a description, and tap **Upload**. Files upload one at a time with a progress bar, automatic retry with backoff, and resume from the last byte Drive received.

Behind the scenes:

| Step | Endpoint | What it does |
| --- | --- | --- |
| Start | `POST /api/upload-session` | Checks the access code, category, `video/*` MIME type and size ≤ 5 GB. Finds/creates the category folder in your root folder, opens a resumable session on Drive and returns its URL. File name: `YYYY-MM-DD-HH-MM-SS_<FO>_<RigIC>_<original name>` (IST). |
| Upload | browser → Drive | `PUT` of 8 MB chunks with `Content-Range`. `308` = continue, `200/201` = done. On network errors / 5xx it backs off, asks Drive for the received byte count (`bytes */total`) and resumes. |
| Log | `POST /api/log` | Re-fetches the file from Drive by id (nothing from the client is trusted), checks it is a video in the right folder, then appends a row: Timestamp (IST), FO Name, Rig IC Number, Category, Description, File Name, Size (MB), Drive Link. Writes the header row if the tab is empty and creates the tab if it doesn't exist. Calling it twice for the same file doesn't create a duplicate row. |

Files are uploaded as **your** Google account (via a stored refresh token), so they count against your Drive storage, not a service account's.

---

## 1. Google Cloud setup

You do this once, signed in with the Google account that should own the videos.

### 1.1 Create a project and enable the APIs

1. Open <https://console.cloud.google.com/> and create a new project (e.g. "FO Video Upload").
2. Go to **APIs & Services → Library** and enable both:
   - **Google Drive API**
   - **Google Sheets API**

### 1.2 Configure the OAuth consent screen — and publish it

1. **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding / Audience / Data Access**).
2. User type: **External**. Fill in the app name and your email.
3. Add the scopes:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets`
4. Add yourself as a test user (you can remove this later).
5. **Publish the app: set the publishing status to "In production".**

> **This step matters.** While the consent screen is in **Testing** mode, Google expires refresh tokens after **7 days**, and uploads will suddenly start failing with `invalid_grant`. Publishing to **In production** removes that expiry.
>
> Because the Drive scope is "restricted", Google shows an *"unverified app"* warning during consent. For a personal tool only you sign in to, that's fine: click **Advanced → Go to <app name> (unsafe)**. You don't need to submit the app for verification, since the only account that ever authorises it is yours.

### 1.3 Create an OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name it anything.
3. Copy the **Client ID** and **Client secret**.

### 1.4 Find your folder and sheet IDs

- **Drive root folder**: create a folder in Google Drive (e.g. "FO Videos"), open it, and copy the last part of the URL:
  `https://drive.google.com/drive/folders/`**`1AbCdEfGhIjKlMnOpQrStUvWxYz`** → that is `DRIVE_ROOT_FOLDER_ID`.
- **Sheet**: create a Google Sheet, open it, and copy the part between `/d/` and `/edit`:
  `https://docs.google.com/spreadsheets/d/`**`1xYz...AbC`**`/edit` → that is `SHEET_ID`.

Both must be owned by (or editable by) the Google account you authorise in the next step. The tab named in `SHEET_TAB` (default `Uploads`) is created automatically if it's missing.

### 1.5 Get the refresh token (one time, on your own computer)

```bash
cp .env.example .env.local
# fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local
npm install
npm run get-token
```

The script opens the Google consent page in your browser and listens on `http://localhost:53682` for the redirect. After you approve, it prints:

```
GOOGLE_REFRESH_TOKEN=1//0g...
```

Paste that into `.env.local` (and later into Vercel). If Google doesn't return a refresh token, remove the app at <https://myaccount.google.com/permissions> and run the script again.

---

## 2. Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | From the Desktop OAuth client |
| `GOOGLE_CLIENT_SECRET` | yes | From the Desktop OAuth client |
| `GOOGLE_REFRESH_TOKEN` | yes | Printed by `npm run get-token` |
| `DRIVE_ROOT_FOLDER_ID` | yes | Parent folder for the category folders |
| `SHEET_ID` | yes | The log spreadsheet |
| `SHEET_TAB` | no | Defaults to `Uploads` |
| `APP_ACCESS_CODE` | no | Shared code FOs type in. Empty = no check |

See `.env.example`.

## 3. Run locally

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev
```

Open <http://localhost:3000>. To test from a phone on the same Wi-Fi, open `http://<your-computer-ip>:3000`. Camera recording and wake lock need HTTPS on a real phone, so for realistic testing use a Vercel preview deployment.

Other scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # production build
npm start           # serve the production build
```

## 4. Deploy to Vercel

1. Push this project to a Git repository (GitHub, GitLab or Bitbucket).
2. In Vercel: **Add New → Project**, import the repo. Framework preset: **Next.js** (auto-detected).
3. Under **Environment Variables**, add everything from the table above (all environments).
4. Deploy. Share the URL and the access code with your FOs.

Notes:

- No special function limits are needed. Only tiny JSON requests reach your server; the video bytes go directly to Google.
- Each upload session is tied to the **Origin** of the page that requested it, so it works on your production domain, preview URLs and `localhost` without extra configuration.
- If you change an environment variable, redeploy for it to take effect.

## 5. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Wrong access code" | The saved code doesn't match `APP_ACCESS_CODE`. Tap **Change** and re-enter it. |
| `invalid_grant` in server logs | Refresh token expired or revoked. Make sure the consent screen is **In production**, then re-run `npm run get-token`. |
| Uploads fail instantly with a network error in the browser | A CORS problem. The session must be created by the same origin that uploads (it's passed through automatically); check you aren't proxying `/api/upload-session` somewhere that strips the `Origin` header. |
| "Drive refused to start the upload" | Check `DRIVE_ROOT_FOLDER_ID`, and that the authorised account can edit that folder. |
| Videos upload but no row appears | Check `SHEET_ID`, and the server logs for `/api/log`. The FO sees the item as failed and can tap **Retry**, which only re-runs the logging step (the video is not uploaded twice). |
| Drive quota errors | Drive limits uploads to about 750 GB per account per day, and your storage plan applies. |

## 6. Security notes

- The access code is a shared secret, not per-user authentication. Anyone who has it can add videos to your Drive. Rotate `APP_ACCESS_CODE` (and redeploy) if it leaks.
- The Google refresh token has full Drive and Sheets access to your account. Keep it only in environment variables, never in the repo (`.env*` is git-ignored).
- The server only ever logs files that Drive confirms are videos sitting inside the expected category folder.
