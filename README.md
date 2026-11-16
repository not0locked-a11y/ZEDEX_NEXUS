# ZEDEX NEXUS

AI-assisted neon newspaper built with Node.js, Express and PostgreSQL for Render.

## Features
- Responsive neon newsroom homepage and latest published stories
- Staff login with admin/editor roles
- Rich article editor: bold, italic, underline, font size, font colour and alignment
- Save drafts, edit articles and publish manually
- AI draft generation using Groq or Gemini
- Scheduled AI draft generation at 00:00, 06:00, 12:00 and 18:00 Asia/Kolkata
- PostgreSQL persistence

## Deploy on Render
1. In Render, choose **New + → Blueprint**.
2. Connect this GitHub repository and deploy using `render.yaml`.
3. In the service Environment settings, set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and at least one AI key (`GROQ_API_KEY` or `GEMINI_API_KEY`). Keep secrets private.
4. Set `AI_PROVIDER` to `groq` or `gemini`.
5. Wait for the web service and PostgreSQL database to become available. Open the generated `onrender.com` URL.

## Important notes
- The scheduled job generates **drafts**, not public posts. An editor reviews and publishes them, preventing unchecked AI output from appearing as verified news.
- The cron schedule runs in the web service process. On a sleeping/free instance, schedules may not run reliably. For dependable publishing, use a paid always-on service or move the schedule to a Render Cron Job.
- The initial admin user is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` at startup. Change these before deployment.
- Staff users can be added by an admin through the API endpoint `POST /api/admin/users` with JSON `{"email":"writer@example.com","password":"a-long-password","role":"editor"}`.
- API keys belong in Render environment variables, never in frontend code or Git.
- AI-generated content is not automatically fact-checked. Verify the source URL and facts before publication.
