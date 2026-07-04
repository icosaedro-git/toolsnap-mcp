# Hermes Agent integration (Fase 19)

Canonical copies of the files to contribute to
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) via PR:

| File here | Destination in hermes-agent |
|---|---|
| `optional-mcps/toolsnap/manifest.yaml` | `optional-mcps/toolsnap/manifest.yaml` |
| `optional-skills/web/toolsnap/SKILL.md` | `optional-skills/web/toolsnap/SKILL.md` |

## Submitting the PR

```bash
gh repo fork NousResearch/hermes-agent --clone hermes-agent-fork
cd hermes-agent-fork
git checkout -b toolsnap-mcp
mkdir -p optional-mcps/toolsnap optional-skills/web/toolsnap
cp ../toolsnap-mcp/integrations/hermes/optional-mcps/toolsnap/manifest.yaml optional-mcps/toolsnap/
cp ../toolsnap-mcp/integrations/hermes/optional-skills/web/toolsnap/SKILL.md optional-skills/web/toolsnap/
git add -A && git commit -m "Add ToolSnap MCP catalog entry + skill (deterministic web/data microtools, x402)"
git push -u origin toolsnap-mcp
gh pr create --repo NousResearch/hermes-agent --title "Add ToolSnap MCP (deterministic web/data microtools) to the catalog" --body-file ../toolsnap-mcp/integrations/hermes/PR_BODY.md
```

Before submitting, smoke-test locally with a Hermes install:

```bash
pipx install hermes-agent   # or their documented install
# add to ~/.hermes/config.yaml:
#   mcp_servers:
#     toolsnap:
#       url: https://mcp.toolsnap.app/mcp
hermes   # then: "extract the text of https://example.com with toolsnap"
```
