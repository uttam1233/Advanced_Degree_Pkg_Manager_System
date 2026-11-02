import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDegreeStorageDistribution,
  formatStorageBytes,
  getStoredRecordBytes,
  setStoredRecordBytes,
} from "../src/storage-usage.js";

test("stored record size matches the UTF-8 size of its JSON payload", () => {
  const record = {
    title: 'Unicode 🎓, quotes " and backslashes \\',
    content: "Café 日本語\n\u0000\u2028",
    unpairedSurrogate: "\ud800",
    optionalValue: undefined,
    cells: ["code", null, { output: "π" }],
  };

  assert.equal(getStoredRecordBytes(record), Buffer.byteLength(JSON.stringify(record)));
});

test("record byte counts include large attachments without serializing them into a temporary copy", () => {
  const record = { dataUrl: `data:application/pdf;base64,${"A".repeat(4_000_000)}` };

  assert.equal(getStoredRecordBytes(record), Buffer.byteLength(JSON.stringify(record)));
});

test("cached database record sizes survive record updates without leaking into JSON", () => {
  const record = { id: "note-1", title: "Large note" };
  setStoredRecordBytes(record, 5_000_000);

  const unchanged = { ...record };
  assert.equal(getStoredRecordBytes(unchanged), 5_000_000);
  const updated = { ...record, title: "Updated note" };
  assert.equal(getStoredRecordBytes(updated), Buffer.byteLength(JSON.stringify(updated)));
  assert.equal(JSON.stringify(updated), '{"id":"note-1","title":"Updated note"}');
});

test("semester slices include all nested records, attachments, notebooks, and degree metadata", () => {
  const degree = { id: "degree-1", name: "First degree", createdAt: "2026-01-01" };
  const semesters = [
    { id: "semester-1", degreeId: degree.id, name: "Semester 1" },
    { id: "semester-2", degreeId: degree.id, name: "Semester 2" },
  ];
  const subjects = [
    { id: "subject-1", semesterId: "semester-1", name: "Mathematics" },
    { id: "subject-2", semesterId: "semester-2", name: "Physics" },
  ];
  const syllabus = [
    { id: "module-1", subjectId: "subject-1", title: "Algebra" },
    { id: "module-2", subjectId: "subject-2", title: "Motion" },
  ];
  const notes = [
    { id: "attachment-1", syllabusId: "module-1", dataUrl: `data:application/pdf;base64,${"A".repeat(12_000)}` },
    { id: "notebook-1", syllabusId: "module-1", cells: [{ outputs: [{ image: "B".repeat(6_000) }] }] },
    { id: "note-2", syllabusId: "module-2", text: "Newton's laws" },
  ];

  const distribution = calculateDegreeStorageDistribution(degree, semesters, subjects, syllabus, notes);
  const firstSemesterSize = [
    semesters[0],
    subjects[0],
    syllabus[0],
    notes[0],
    notes[1],
  ].reduce((total, record) => total + getStoredRecordBytes(record), 0);
  const secondSemesterSize = [
    semesters[1],
    subjects[1],
    syllabus[1],
    notes[2],
  ].reduce((total, record) => total + getStoredRecordBytes(record), 0);

  assert.equal(distribution.find((slice) => slice.id === "semester-1").size, firstSemesterSize);
  assert.equal(distribution.find((slice) => slice.id === "semester-2").size, secondSemesterSize);
  assert.equal(distribution.find((slice) => slice.id === "degree-profile").size, getStoredRecordBytes(degree));
  assert.equal(
    distribution.reduce((total, slice) => total + slice.size, 0),
    getStoredRecordBytes(degree) + firstSemesterSize + secondSemesterSize,
  );
  assert.equal(new Set(distribution.map((slice) => slice.color)).size, distribution.length);
});

test("degree distributions stay independent when the selected degree changes", () => {
  const first = calculateDegreeStorageDistribution(
    { id: "degree-1", name: "First degree" },
    [{ id: "semester-1", name: "First semester" }],
    [{ id: "subject-1", semesterId: "semester-1", name: "First subject" }],
    [],
    [],
  );
  const second = calculateDegreeStorageDistribution(
    { id: "degree-2", name: "Second degree" },
    [{ id: "semester-2", name: "Second semester" }],
    [],
    [],
    [],
  );

  assert.deepEqual(first.map((slice) => slice.label), ["Degree profile", "First semester"]);
  assert.deepEqual(second.map((slice) => slice.label), ["Degree profile", "Second semester"]);
  assert.equal(first[1].size, getStoredRecordBytes({ id: "semester-1", name: "First semester" })
    + getStoredRecordBytes({ id: "subject-1", semesterId: "semester-1", name: "First subject" }));
  assert.equal(second[1].size, getStoredRecordBytes({ id: "semester-2", name: "Second semester" }));
});

test("storage sizes use readable binary units and preserve byte precision for small records", () => {
  assert.equal(formatStorageBytes(0), "0 B");
  assert.equal(formatStorageBytes(512), "512 B");
  assert.equal(formatStorageBytes(1_048_576), "1.00 MB");
  assert.equal(formatStorageBytes(1_500), "1.46 KB");
});
