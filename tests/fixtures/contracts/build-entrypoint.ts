import { fileURLToPath } from "node:url";

interface BuildRequest {
  mode: "semantic" | "auth";
  entrypoint: string;
  outfile: string;
  external: string[];
  define?: Record<string, string>;
  semanticModule?: string;
  testHang?: true;
}

const serialized = process.argv[2];
if (!serialized) throw new Error("contract build request is required");
const request = JSON.parse(serialized) as BuildRequest;
if (
  (request.mode !== "semantic" && request.mode !== "auth") ||
  typeof request.entrypoint !== "string" ||
  typeof request.outfile !== "string" ||
  !Array.isArray(request.external)
) {
  throw new Error("contract build request is invalid");
}
if (request.testHang === true) {
  await new Promise<never>(() => {});
}

const contractFixture = (name: string): string =>
  fileURLToPath(new URL(name, import.meta.url));

const plugin: Bun.BunPlugin = request.mode === "auth"
  ? {
      name: "isolated-auth-contract-boundaries",
      setup(build) {
        build.onResolve({ filter: /(?:^|\/)client\.js$/ }, () => ({
          path: contractFixture("auth-client.ts"),
        }));
        build.onResolve({ filter: /store\/db\.js$/ }, () => ({
          path: contractFixture("auth-store.ts"),
        }));
        build.onResolve({ filter: /sync\/spawn\.js$/ }, () => ({
          path: contractFixture("auth-spawn.ts"),
        }));
        build.onResolve(
          { filter: /(?:^|\/)session-publication\.js$/ },
          () => ({ path: contractFixture("auth-session.ts") }),
        );
      },
    }
  : {
      name: "isolated-semantic-contract-state",
      setup(build) {
        build.onResolve({ filter: /(?:^|\/)client\.js$/ }, () => ({
          path: contractFixture("semantic-client.ts"),
        }));
        build.onResolve({ filter: /store\/db\.js$/ }, () => ({
          path: contractFixture("semantic-store.ts"),
        }));
        build.onResolve({ filter: /sync\/spawn\.js$/ }, () => ({
          path: contractFixture("semantic-spawn.ts"),
        }));
        if (request.semanticModule !== undefined) {
          build.onResolve({ filter: /semantic\/semantic\.js$/ }, () => ({
            path: request.semanticModule!,
          }));
        }
      },
    };

const result = await Bun.build({
  entrypoints: [request.entrypoint],
  outfile: request.outfile,
  target: "bun",
  external: request.external,
  define: request.define,
  plugins: [plugin],
});
if (!result.success) {
  throw new Error(
    `contract build failed: ${result.logs
      .map((log) => log.message)
      .join("; ")}`,
  );
}
if (result.outputs.length !== 1 || !result.outputs[0]?.path) {
  throw new Error(
    `contract build emitted ${result.outputs.length} outputs instead of one`,
  );
}
await Bun.write(request.outfile, result.outputs[0]);
