import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Placeholder: full implementation tracked by ADR-001 / PRD-001.
export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ask", {
    description: "Ask a structured question (placeholder).",
    handler: async (_args, ctx) => {
      ctx.ui.notify("ask_user_question: not yet implemented. See docs/adr and docs/prd.", "info");
    },
  });
}
