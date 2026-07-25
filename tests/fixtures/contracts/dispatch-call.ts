interface DispatchRequest {
  tool: string;
  args: Record<string, unknown>;
}

function parseRequest(value: unknown): DispatchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatcher request must be a plain object");
  }
  const request = value as { tool?: unknown; args?: unknown };
  if (typeof request.tool !== "string") {
    throw new Error("dispatcher tool must be a string");
  }
  if (
    request.args === null ||
    typeof request.args !== "object" ||
    Array.isArray(request.args)
  ) {
    throw new Error("dispatcher args must be a plain object");
  }
  return request as DispatchRequest;
}

const requestText = process.argv[2];
if (!requestText) throw new Error("dispatcher request JSON is required");
const parsed: unknown = JSON.parse(requestText);
const batch = Array.isArray(parsed);
const requests = batch ? parsed.map(parseRequest) : [parseRequest(parsed)];

const { sana } = await import("../../../src/tools/dispatch.js");
const outputs: string[] = [];
for (const request of requests) {
  outputs.push(await sana(request.tool, request.args));
}
process.stdout.write(batch ? JSON.stringify(outputs) : outputs[0]!);
