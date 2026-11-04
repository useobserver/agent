## Deploy

Run the agent on your own platform account. Every option runs the same
image (`ghcr.io/useobserver/agent:1`) as a small always-on service with no
public port. Your platform's pricing applies. Create the agent in Observer
first (Agents, Add agent) and paste its key when the platform asks for
`AGENT_KEY`.

| Platform | Deploy | Offline queue |
|---|---|---|
| Render | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/useobserver/agent) | persistent disk |
| DigitalOcean | [![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/useobserver/agent/tree/main) | lost on redeploy (App Platform has no volumes) |
| Railway | template coming soon | volume |
| Fly.io | in an empty directory: `fly launch --from https://github.com/useobserver/agent --copy-config --no-deploy`, then `fly secrets set AGENT_KEY=...` and `fly deploy` | volume |
| Coolify, Dokploy, Portainer | [`docker-compose.yml`](../docker-compose.yml) as a Docker Compose service or stack | volume |
| Linux, macOS | `curl -fsSL https://use.observer/install.sh \| AGENT_KEY=obs_live_... sh` | on disk |

The templates: [`render.yaml`](../render.yaml), [`fly.toml`](../fly.toml)
and [`.do/deploy.template.yaml`](../.do/deploy.template.yaml) at the
repository root (where the platforms look), the Railway template spec in
[`railway/`](railway/) and the Dokploy template in [`dokploy/`](dokploy/).
The same table is in the repository README.
