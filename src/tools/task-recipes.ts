import type { McpTool } from "../mcp/types.js";
import { RECIPES, recipeMenu } from "../recipes.js";

/**
 * task_recipes (free) — a menu of pre-designed multi-tool workflows.
 *
 * The agent calls it with no args to get the menu, then with `recipe: "<id>"`
 * to get a ready-to-run prompt that drives the right ToolSnap tools end-to-end.
 * This is self-marketing: it teaches agents the high-value bundles (B6).
 */
export const taskRecipesTool: McpTool = {
  name: "task_recipes",
  description:
    "Free. Returns a menu of pre-designed complex tasks that ToolSnap makes easy (e.g. replicate a website as static HTML, run an SEO audit), each as a ready-to-run prompt that orchestrates the right ToolSnap tools end-to-end. Call with no arguments to list available recipes; call with recipe='<id>' to get the full ready-to-paste prompt, the tools it uses and an estimated cost. Use this when the user asks for a whole task (migrate/clone a site, audit SEO, etc.) rather than a single operation.",
  inputSchema: {
    type: "object",
    properties: {
      recipe: {
        type: "string",
        description:
          "The recipe id to expand (e.g. 'replicate_website', 'seo_audit'). Omit to list the menu.",
      },
    },
    required: [],
  },
  run(args) {
    const id = typeof args.recipe === "string" ? args.recipe.trim() : "";
    if (!id) {
      return JSON.stringify(
        {
          recipes: recipeMenu(),
          how_to_use:
            "Call task_recipes again with recipe='<id>' to get the full ready-to-paste prompt for that task.",
        },
        null,
        2
      );
    }
    const recipe = RECIPES.find((r) => r.id === id);
    if (!recipe) {
      throw new Error(
        `Unknown recipe "${id}". Available: ${RECIPES.map((r) => r.id).join(", ")}`
      );
    }
    return JSON.stringify(recipe, null, 2);
  },
};
