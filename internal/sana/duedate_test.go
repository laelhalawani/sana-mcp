package sana

import (
	"encoding/json"
	"testing"
)

// Sana changed dueDate from a string to epoch milliseconds. One item failing to
// decode rejected the whole meeting document, so eight meetings lost their
// metadata on every sync cycle indefinitely. Both shapes have to work, and an
// unknown third one must not throw the document away.
func TestDueDateAcceptsEveryShapeSanaHasSent(t *testing.T) {
	for _, testCase := range []struct {
		name string
		raw  string
		want string
	}{
		{"epoch milliseconds, as sent now", `1702339200000`, "2023-12-12"},
		{"end of a day", `1704067199000`, "2023-12-31"},
		{"a string, as sent before", `"2026-08-01"`, "2026-08-01"},
		{"absent", `null`, ""},
		{"zero is not a date", `0`, ""},
		{"an unknown shape is kept, not fatal", `{"at":"soon"}`, `{"at":"soon"}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var due DueDate
			if err := json.Unmarshal([]byte(testCase.raw), &due); err != nil {
				t.Fatalf("decoding %s must never fail: %v", testCase.raw, err)
			}
			if due.String() != testCase.want {
				t.Fatalf("got %q, want %q", due.String(), testCase.want)
			}
			if due.Set() != (testCase.want != "") {
				t.Fatalf("Set() = %v for %q", due.Set(), due.String())
			}
		})
	}
}

// The metadata document is stored by marshalling this struct and read back by
// unmarshalling it, so a due date has to survive the round trip.
func TestDueDateSurvivesStorage(t *testing.T) {
	var decoded struct {
		ActionItems []ActionItem `json:"actionItems"`
	}
	incoming := `{"actionItems":[{"action":"scale to 500 products","assignedTo":"Julia","dueDate":1702339200000}]}`
	if err := json.Unmarshal([]byte(incoming), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	stored, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var reread struct {
		ActionItems []ActionItem `json:"actionItems"`
	}
	if err := json.Unmarshal(stored, &reread); err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if got := reread.ActionItems[0].DueDate.String(); got != "2023-12-12" {
		t.Fatalf("after a round trip the due date is %q", got)
	}
}

// The failure that was actually reported: a whole meeting document rejected
// because of one field.
func TestMetadataDecodesDespiteANumericDueDate(t *testing.T) {
	payload := `{"summary":"we agreed the plan","actionItems":[
	  {"action":"send the list","assignedTo":null,"dueDate":null},
	  {"action":"scale to 500","assignedTo":"Julia","dueDate":1702339200000}]}`
	var metadata Metadata
	if err := json.Unmarshal([]byte(payload), &metadata); err != nil {
		t.Fatalf("a numeric dueDate must not reject the document: %v", err)
	}
	if len(metadata.ActionItems) != 2 {
		t.Fatalf("expected both action items, got %d", len(metadata.ActionItems))
	}
	if metadata.Summary == nil || *metadata.Summary != "we agreed the plan" {
		t.Fatal("the summary must survive")
	}
	if metadata.ActionItems[1].DueDate.String() != "2023-12-12" {
		t.Fatalf("due date is %q", metadata.ActionItems[1].DueDate)
	}
}
