const ESC = "\u001b";
const BIDI = "\u202e";
const CONTROL = "\u0007";

export async function runHumanCommand(
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (tool) {
    case "args":
      return JSON.stringify(args);
    case "list":
      return `# Meetings\n\n| title |\n|---|\n| ${ESC}[31mRed${ESC}[0m ${BIDI}title${CONTROL} |`;
    case "read":
      return `# Meeting\n\n[00:01] ${ESC}]8;;https://example.test${ESC}\\Speaker${ESC}]8;;${ESC}\\: transcript${BIDI}${CONTROL}`;
    case "summary":
      return `# Summary\n\n- Note ${ESC}[2Jhidden${BIDI}${CONTROL}`;
    case "participants":
      return `| name | email |\n|---|---|\n| Part${BIDI}icipant${CONTROL} | person@example.test |`;
    case "search":
      return `| meeting | snippet |\n|---|---|\n| ${ESC}[32mSearch title${ESC}[0m | result${BIDI}${CONTROL} |`;
    case "ordinary":
      return "First\tline\n\nSecond line";
    case "large":
      return "L".repeat(4 * 1024 * 1024);
    case "error":
      throw new Error(
        `Remote ${ESC}[31merror${ESC}[0m ${BIDI}detail${CONTROL}`,
      );
    default:
      return "ok";
  }
}
