import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Builds the tiny multi-file collection torrent the e2e run drops into
 * `collections/8/` (8 = IGDB's PlayStation 2). Run it with
 * `pnpm exec tsx tests/fixtures/make-collection-torrent.ts`; the output is
 * committed so the e2e run needs no build step.
 */
const root = "Fixture Collection";
const files = [
  { name: "Fixture Quest (USA).iso", content: Buffer.from("quest-iso") },
  { name: "Another Game (Europe).iso", content: Buffer.from("other-iso") },
  { name: "Third Game (Japan).iso", content: Buffer.from("third-iso") }
];

const text = (value: string) => Buffer.from(`${value.length}:${value}`);
const bytes = (value: Buffer) =>
  Buffer.concat([Buffer.from(`${value.length}:`), value]);

const entries = files.map((file) => Buffer.concat([
  Buffer.from(`d6:lengthi${file.content.length}e4:pathl`),
  text(file.name),
  Buffer.from("ee")
]));
const pieces = createHash("sha1")
  .update(Buffer.concat(files.map((file) => file.content)))
  .digest();

const info = Buffer.concat([
  Buffer.from("d5:filesl"),
  ...entries,
  Buffer.from("e4:name"),
  text(root),
  Buffer.from("12:piece lengthi16384e6:pieces"),
  bytes(pieces),
  Buffer.from("e")
]);

const output = path.resolve("tests/fixtures/collections/8/ps2-test.torrent");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([Buffer.from("d4:info"), info, Buffer.from("e")]));
