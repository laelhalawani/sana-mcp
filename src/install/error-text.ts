const MAX_AGGREGATE_DEPTH = 3;
const MAX_AGGREGATE_CHILDREN = 6;

/** Preserve bounded nested AggregateError details for observable cleanup paths. */
export function boundedErrorText(error: unknown, depth = 0): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AggregateError) || depth >= MAX_AGGREGATE_DEPTH)
    return message;
  const children = [...error.errors]
    .slice(0, MAX_AGGREGATE_CHILDREN)
    .map((child) => boundedErrorText(child, depth + 1));
  if (error.errors.length > MAX_AGGREGATE_CHILDREN)
    children.push(
      `${error.errors.length - MAX_AGGREGATE_CHILDREN} additional error(s) omitted`,
    );
  return children.length === 0 ? message : `${message}: ${children.join("; ")}`;
}
