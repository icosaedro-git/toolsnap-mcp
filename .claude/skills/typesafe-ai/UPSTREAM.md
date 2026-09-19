# Procedencia de esta skill

Copia literal de `skills/typesafe-ai/` de <https://github.com/typesafe-ai/skills>
(MIT), fijada en el commit `65a39f393687675ce170e6094757de20370365b9` (2026-09-12).

Se vendoriza en lugar de instalarse como plugin de marketplace
(`claude plugin marketplace add typesafe-ai/skills`) porque el trabajo en este
repo ocurre casi siempre en sesiones de Claude Code en web, donde un
`extraKnownMarketplaces` + `enabledPlugins` comiteado en `.claude/settings.json`
no llega a procesarse (anthropics/claude-code#78119). Un directorio de skill
dentro del repo sí se carga en cualquier superficie, y son 10 KB.

La propia documentación de TypeSafe contempla esta vía: "For manual
installation, copy the entire skills/typesafe-ai directory, including its
reference files, into your agent's skills directory"
(<https://docs.typesafe.ai/agent-skill>).

## Cómo actualizarla

```bash
git clone --depth 1 https://github.com/typesafe-ai/skills.git /tmp/ts-skills
cp /tmp/ts-skills/skills/typesafe-ai/{SKILL.md,LICENSE} .claude/skills/typesafe-ai/
git -C /tmp/ts-skills rev-parse HEAD   # actualiza el commit fijado arriba
```

Merece la pena hacerlo cuando el agente empiece a inventarse campos de la
petición o de la respuesta: la propia documentación señala una skill obsoleta
como la causa habitual. **Elegir una sola vía de instalación**: si algún día se
instala el plugin, borrar este directorio para no tener dos copias divergentes.

La skill manda leer la documentación viva en cada tarea
(<https://docs.typesafe.ai/llms.txt>), así que el SKILL.md fijado envejece mucho
mejor que una copia de los contratos de la API.
