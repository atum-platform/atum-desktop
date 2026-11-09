import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface FixtureEntry {
  file: string;
  message?: string;
  machine?: string;
  expect: "accept" | "reject";
  violation?: string;
}

export const readFixture = (pack: string, file: string): any => JSON.parse(readFileSync(join(root, pack, file), "utf8"));
export const readFixtureText = (pack: string, file: string): string => readFileSync(join(root, pack, file), "utf8");
export const packContract = (pack: string): any => readFixture(pack, "contract.json");

/** The pack's declared fixtures, optionally only those of one message. */
export function fixtureEntries(pack: string, message?: string): FixtureEntry[] {
  const entries = packContract(pack).fixtures as FixtureEntry[];
  return message === undefined ? entries : entries.filter((entry) => entry.message === message);
}

/** The pack's declared fixtures of one message, loaded, with their declared expectation. */
export function cases(pack: string, message: string): { entry: FixtureEntry; name: string; value: any }[] {
  return fixtureEntries(pack, message).map((entry) => ({ entry, name: entry.file.replace(/^fixtures\//, ""), value: readFixture(pack, entry.file) }));
}
