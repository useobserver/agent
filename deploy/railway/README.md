# Railway template checklist

Railway templates are made in the Railway dashboard, not from a file.
[`template.json`](template.json) is the source of truth for what goes in;
this is the click-by-click list. Re-check it against `template.json` before
every change to the published template.

1. Railway dashboard → workspace → **Templates** → **New Template**.
2. **Add New** → **Docker Image** → `ghcr.io/useobserver/agent:1`.
   Never `latest`, never an exact version.
3. Service name: `observer-agent`.
4. **Variables**:
   - `AGENT_KEY`: no default, required. Description:
     `From Observer: Agents → Add agent`.
   - `CLOUD_SERVER_URL` = `https://use.observer`
   - `BUFFER_PATH` = `/data/observer-agent-buffer.db`
5. Right-click the service → **Attach Volume** → mount path `/data`.
6. **Settings** → **Networking**: leave public networking off (no domain,
   no TCP proxy). The agent only makes outbound calls.
7. **Settings** → **Deploy**: one replica.
8. Template details:
   - Name: `Observer Agent`
   - Description: the `description` in `template.json`
   - Icon: `https://use.observer/logo-transparent.svg`
   - Category: `Observability`
9. **Create Template**, then **Publish**.
10. Copy the template code (the last part of the template URL) into
    `RAILWAY_TEMPLATE_CODE` in `apps/web/lib/agent-snippets.ts` and the
    Railway row of [`../README.md`](../README.md). The console shows the
    Railway card once the code is set.

Deploy button, once published:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<code>)
```
