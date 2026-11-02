import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const PLUG = process.env.PLUG!;
const JOB = process.env.JOB!;
const transport = new StdioClientTransport({ command: "node", args: [`/home/box/.grok/installed-plugins/${PLUG}/mcp/launch.mjs`] });
const client = new Client({ name: "poll", version: "1" }, { capabilities: {} });
await client.connect(transport);
for (let i = 0; i < 40; i++) {
  const r: any = await client.callTool({ name: "check_sequence", arguments: { jobId: JOB } }, undefined, { timeout: 580000 });
  const p = JSON.parse(r.content[0].text);
  console.log(new Date().toISOString().slice(11,19), p.state, p.progress, "$" + (p.spentUsd ?? 0));
  if (p.done) { console.log(JSON.stringify(p, null, 1).slice(0, 2500)); break; }
  await new Promise((r) => setTimeout(r, 25000));
}
await client.close();
