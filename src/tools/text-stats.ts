import type { McpTool } from "../mcp/types.js";

export const textStatsTool: McpTool = {
  name: "text_stats",
  description:
    "Count characters, words, lines, and sentences in a text string. Returns a JSON object. Use when you need to analyse or report on the size and structure of a body of text.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to analyse.",
      },
    },
    required: ["text"],
  },
  run(args) {
    if (typeof args.text !== "string") {
      throw new Error("text must be a string.");
    }
    const text = args.text;

    const characters = text.length;
    const charactersNoSpaces = text.replace(/\s/g, "").length;

    // Words: sequences of non-whitespace characters
    const wordMatches = text.match(/\S+/g);
    const words = wordMatches ? wordMatches.length : 0;

    // Lines: split on newlines (empty string = 1 line)
    const lines = text === "" ? 0 : text.split(/\r?\n/).length;

    // Sentences: split on . ! ? followed by whitespace or end of string
    const sentenceMatches = text.match(/[^.!?]*[.!?]+(\s|$)/g);
    const sentences = sentenceMatches ? sentenceMatches.length : (text.trim().length > 0 ? 1 : 0);

    return JSON.stringify({ characters, charactersNoSpaces, words, lines, sentences }, null, 2);
  },
};
