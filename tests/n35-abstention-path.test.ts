/**
 * N35: a job file that is present but unreadable or invalid JSON is cited
 * by path. A missing file stays an empty artifactPaths list.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JOBS_DIR } from "../mcp/media.ts";
import { server } from "../mcp/server.ts";

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

type Finding = {
  summary: string;
  class: string;
  jobIds: string[];
  evidence?: { method: string; artifactPaths: string[] };
};

let client: Client;

beforeAll(async () => {
  await mkdir(JOBS_DIR, { recursive: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "n35-abstention", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

function findingFor(body: { findings: Finding[] }, id: string): Finding {
  const found = body.findings.find((item) => item.jobIds.includes(id));
  if (!found) throw new Error(`no finding for ${id}`);
  return found;
}

describe("check_cross_film abstention paths", () => {
  it("cites an unreadable job file and an invalid JSON file, and leaves a missing file uncited", async () => {
    const unreadable = "seq_n35_unreadable";
    const invalid = "seq_n35_invalid";
    const good = "seq_n35_good";
    const absent = "seq_n35_absent";
    const unreadablePath = path.join(JOBS_DIR, `${unreadable}.json`);
    const invalidPath = path.join(JOBS_DIR, `${invalid}.json`);
    // A directory at the job path makes readFile throw EISDIR for every uid.
    // chmod 0 does not: root still reads the file and the case stops being "unreadable".
    await mkdir(unreadablePath);
    await writeFile(invalidPath, '{ "id": "seq_n35_invalid", "startedAt": ');
    await writeFile(path.join(JOBS_DIR, `${good}.json`), JSON.stringify({
      id: good,
      startedAt: 2,
      state: "completed",
      spentUsd: 0,
      shots: [{ index: 1, title: "Ok" }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "m", pin: "start" },
    }));

    const body = JSON.parse(toolText(await client.callTool({
      name: "check_cross_film",
      arguments: { jobIds: [unreadable, invalid, good, absent] },
    }))) as { findings: Finding[]; mutatedPaths: string[]; executed: boolean };

    expect(body.executed).toBe(false);
    expect(body.mutatedPaths).toEqual([]);

    const unreadableFinding = findingFor(body, unreadable);
    expect(unreadableFinding.class).toBe("unverified");
    expect(unreadableFinding.summary).toMatch(/present but could not be parsed: unreadable/);
    expect(unreadableFinding.evidence).toEqual({ method: "abstain", artifactPaths: [unreadablePath] });

    const invalidFinding = findingFor(body, invalid);
    expect(invalidFinding.class).toBe("unverified");
    expect(invalidFinding.summary).toMatch(/present but could not be parsed: invalid JSON/);
    expect(invalidFinding.evidence).toEqual({ method: "abstain", artifactPaths: [invalidPath] });

    const absentFinding = findingFor(body, absent);
    expect(absentFinding.summary).toBe("Job file not on disk.");
    expect(absentFinding.evidence).toEqual({ method: "abstain", artifactPaths: [] });
  });
});
