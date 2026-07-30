if (process.argv[2] === "__semantic-worker") {
  await import("./embedding-worker-entry.js");
} else if (process.argv[2] === "__semantic-smoke") {
  try {
    const { runStandaloneSemanticSmoke } = await import("./smoke.js");
    await runStandaloneSemanticSmoke();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  await import("../cli.js");
}
