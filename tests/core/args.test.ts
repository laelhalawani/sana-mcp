import { describe, expect, test } from "bun:test";
import {
  ArgumentValidationError,
  argMeetingId,
  parseFilters,
  parseReadArguments,
  positiveIntegerArgument,
  validateSearchArguments,
} from "../../src/core/args.js";

function invalid(operation: () => unknown, field: string): void {
  expect(operation).toThrow(ArgumentValidationError);
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ArgumentValidationError);
    expect((error as ArgumentValidationError).field).toBe(field);
  }
}

describe("open-record MCP argument validation", () => {
  test("pagination defaults only when absent", () => {
    expect(positiveIntegerArgument({}, "page", 1)).toBe(1);
    expect(positiveIntegerArgument({ page: 2 }, "page", 1)).toBe(2);

    for (const value of [undefined, null, "2", 0, -1, 1.5, NaN, Infinity]) {
      invalid(
        () => positiveIntegerArgument({ page: value }, "page", 1),
        "page",
      );
    }
  });

  test("filter dates, status, shape, and range are exact", () => {
    expect(parseFilters({})).toEqual({});
    expect(
      parseFilters({
        filter: {
          status: "ready",
          date: { from: "2026-01-03", to: "2026-01-03" },
        },
      }),
    ).toEqual({
      status: "ready",
      dateFrom: Date.parse("2026-01-03T00:00:00Z"),
      dateTo: Date.parse("2026-01-04T00:00:00Z") - 1,
    });
    expect(parseFilters({ filter: { status: "processing" } })).toEqual({
      status: "processing",
    });
    expect(parseFilters({ filter: { status: "retrying" } })).toEqual({
      status: "retrying",
    });
    expect(
      parseFilters({
        filter: {
          date: { from: "2026-01-03T12:30:00+01:00" },
        },
      }).dateFrom,
    ).toBe(Date.parse("2026-01-03T12:30:00+01:00"));

    invalid(() => parseFilters({ filter: null }), "filter");
    invalid(() => parseFilters({ filter: [] }), "filter");
    invalid(
      () => parseFilters({ filter: { status: "failed" } }),
      "filter.status",
    );
    invalid(
      () => parseFilters({ filter: { unexpected: true } }),
      "filter.unexpected",
    );
    invalid(
      () => parseFilters({ filter: { date: null } }),
      "filter.date",
    );
    invalid(
      () => parseFilters({ filter: { date: { from: undefined } } }),
      "filter.date.from",
    );
    invalid(
      () => parseFilters({ filter: { date: { from: "2026-02-30" } } }),
      "filter.date.from",
    );
    invalid(
      () =>
        parseFilters({
          filter: { date: { from: "2026-02-30T12:00:00Z" } },
        }),
      "filter.date.from",
    );
    invalid(
      () =>
        parseFilters({
          filter: { date: { from: "2026-02-03T12:00:00" } },
        }),
      "filter.date.from",
    );
    invalid(
      () =>
        parseFilters({
          filter: {
            date: { from: "2026-02-04", to: "2026-02-03" },
          },
        }),
      "filter.date",
    );
  });

  test("read booleans and line ranges are never coerced", () => {
    expect(parseReadArguments({})).toEqual({
      full: false,
      timestamps: true,
      lines: null,
    });
    expect(
      parseReadArguments({
        full: true,
        timestamps: false,
        lines: [2, 4],
      }),
    ).toEqual({ full: true, timestamps: false, lines: [2, 4] });

    invalid(() => parseReadArguments({ full: "true" }), "full");
    invalid(
      () => parseReadArguments({ timestamps: "false" }),
      "timestamps",
    );
    for (const lines of [
      null,
      [],
      [1],
      [1, 2, 3],
      ["1", 2],
      [0, 2],
      [3, 2],
      [1, 2.5],
    ]) {
      invalid(() => parseReadArguments({ lines }), "lines");
    }
  });

  test("meeting id does not fall through a malformed explicit alias", () => {
    expect(argMeetingId({ id: "meeting-a" })).toBe("meeting-a");
    expect(argMeetingId({ meeting_id: "meeting-b", id: "meeting-a" })).toBe(
      "meeting-b",
    );
    invalid(
      () => argMeetingId({ meeting_id: 7, id: "meeting-a" }),
      "meeting_id",
    );
    invalid(() => argMeetingId({ id: "" }), "id");
    invalid(() => argMeetingId({ id: " meeting-a " }), "id");
  });

  test("search validates its actual open-record fields before core search", () => {
    expect(() =>
      validateSearchArguments({
        query: "pricing",
        page: 2,
        limit: 100,
        sort: "newest",
        filter: { date: { from: 0 } },
      }),
    ).not.toThrow();
    invalid(() => validateSearchArguments({ query: 4 }), "query");
    invalid(() => validateSearchArguments({ page: "2" }), "page");
    invalid(() => validateSearchArguments({ limit: 101 }), "limit");
    invalid(() => validateSearchArguments({ sort: "recent" }), "sort");
    invalid(
      () =>
        validateSearchArguments({
          filter: { status: "ready" },
        }),
      "filter.status",
    );
  });
});
