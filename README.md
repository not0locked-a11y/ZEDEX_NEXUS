# ZEDEX NEXUS

AI-assisted neon newspaper. Render hosts the application and stores **user accounts only** in PostgreSQL. Google Drive is the exclusive storage location for all editorial content and uploaded media.

## Storage policy
- Render PostgreSQL: user email, bcrypt password hash, role and account creation time only.
- Google Drive folder: every article, draft, AI-generated draft, uploaded image and media file.
- No article body, draft, photo or uploaded media is written to PostgreSQL or the Render local filesystem.
- Images are uploaded through `POST /api/admin/media` as multipart form data with field name `file`; the response contains a Drive-backed `/api/media/:id` URL.

## Google Drive setup (required)
1. Sign in to Google Cloud Console using **not0locked@gmail.com** and create/select a project.
2. Enable **Google Drive API** for that project.
3. Configure the OAuth consent screen for the project.
4. Create an OAuth 2.0 Client ID (Desktop app is suitable for generating a refresh token).
5. Generate an OAuth refresh token with the scope `https://www.googleapis.com/auth/drive` using that client. Keep the client secret and refresh token private.
6. In the same Google account, create a Drive folder named `ZEDEX NEXUS`. Copy its folder ID from the folder URL.
7. Add these values to Render → ZEDEX NEXUS → Environment:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `GOOGLE_DRIVE_FOLDER_ID`
8. Save changes and redeploy. The Google OAuth account must have access to the selected folder.

Do not put OAuth secrets in GitHub, the frontend, or this README. Do not share them in chat.

## Deploy on Render
1. Create/update the Blueprint from this repository using `render.yaml`.
2. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and at least one AI key.
3. Complete the Google Drive setup above before using article or media features.
4. Set `AI_PROVIDER` to `groq` or `gemini`.

## Features
- Neon newspaper frontend and staff login
- Admin-created editor/publisher accounts
- Rich article editor and manual publishing
- Article and draft JSON files stored in Google Drive
- Image/media uploads stored in Google Drive
- Groq or Gemini AI draft generation; scheduled drafts at 00:00, 06:00, 12:00 and 18:00 Asia/Kolkata

## Notes
- AI output is saved as a draft for human review, not automatically published.
- AI-generated claims and source URLs must be checked before publication.
- The scheduled job runs in the web service; Render free instances may sleep, so schedules are not guaranteed to execute on time.
- Google Drive API quota and account storage limits apply.
- Back up the Drive folder and protect the OAuth refresh token.
