try {
  const { dataDirectory } = await import("../../../src/config.js");
  const { databaseFile, SanaStore } = await import("../../../src/store/db.js");
  if (process.argv[2] === "import-only") {
    process.stdout.write(`${JSON.stringify({ kind: "imported" })}\n`);
    process.exit(0);
  }
  const store = new SanaStore();
  store.close();
  process.stdout.write(
    `${JSON.stringify({
      kind: "ready",
      dataDir: dataDirectory(),
      dbFile: databaseFile(),
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      kind: "error",
      name: error instanceof Error ? error.name : typeof error,
      code:
        error !== null &&
        typeof error === "object" &&
        "code" in error
          ? error.code
          : null,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 73;
}
