# GitHub App settings for step 2.6

Existing 2.1 settings (App ID, client id/secret, private key, slug) stay. Add:

1. **Webhook**: Active; URL `{API_PUBLIC_URL}/integrations/github/webhook`; content type `application/json`; secret = `GITHUB_WEBHOOK_SECRET` (16+ chars; without it every delivery is answered 401).
2. **Repository permissions**: Metadata (read, always), Pull requests (read), Issues (read), Contents (read; needed for push/branch events).
3. **Subscribe to events**: Pull request, Issues, Push, Create. (Installation and installation-repositories events are delivered to every App automatically.)
4. Existing installations must accept the new permissions (GitHub asks the owner to approve) before events start arriving.

Then in the product: connect GitHub (2.1), `GET /integrations/connections/:id/github/repositories`, `POST /integrations/connections/:id/github/repo-links {repoId, projectId}`. A PR titled `ENG-123 ...` (or branch `eng-123-...`) now links to ENG-123 and, with the defaults, moves it to In progress and then Done on merge.
