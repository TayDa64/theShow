import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const PLUG = process.env.PLUG!;
const transport = new StdioClientTransport({ command: "node", args: [`/home/box/.grok/installed-plugins/${PLUG}/mcp/launch.mjs`] });
const client = new Client({ name: "proof", version: "1" }, { capabilities: {} });
await client.connect(transport);

const SHOTS = [
  { title: "Establishing", durationSeconds: 6, action: "Tay stands at the desk, three-quarter view, studying a glowing holographic model of a tower above it." },
  { title: "Hands", durationSeconds: 6, action: "Close on Tay's hands pushing a glowing wireframe building into place above the desk." },
  { title: "Study", durationSeconds: 6, action: "Medium side view, Tay steps back and folds his arms, studying the model." },
  { title: "Resolve", durationSeconds: 6, action: "Front on, Tay nods slowly, satisfied, the model rotating between him and the camera." },
];
const CAST =
  "Tay: bald head, full black beard with grey flecks at the chin, warm medium-brown skin, " +
  "blue and white vertical-striped button-down shirt under a tan sherpa-collar jacket " +
  "with a dark navy blazer beneath it";

const r: any = await client.callTool({
  name: "board_film",
  arguments: { shots: SHOTS, cast: CAST, characters: ["Tay", "17th Floor Office"], aspectRatio: "16:9", confirm: true, maxCostUsd: 1 },
}, undefined, { timeout: 580000 });
const p = JSON.parse(r.content[0].text);
console.log(JSON.stringify({ action: p.action, estimate: p.estimate, frames: (p.frames??[]).map((f:any)=>({i:f.index,path:f.path})), shots:(p.shots??[]).map((s:any)=>({i:s.index,title:s.title,first:s.firstFrameUrl,last:s.lastFrameUrl})) }, null, 2));
await client.close();
