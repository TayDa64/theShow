import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const PLUG = process.env.PLUG!;
const transport = new StdioClientTransport({ command: "node", args: [`/home/box/.grok/installed-plugins/${PLUG}/mcp/launch.mjs`] });
const client = new Client({ name: "proof", version: "1" }, { capabilities: {} });
await client.connect(transport);

const SHOTS = [
  { index: 1, title: "Establishing", durationSeconds: 6, prompt: "Tay stands at the desk, three-quarter view, studying a glowing holographic model of a tower above it.", firstFrameUrl: "/home/box/.theshow/media/board-64978a0feba329ee.jpg", lastFrameUrl: "/home/box/.theshow/media/board-a175e37274ff6439.jpg" },
  { index: 2, title: "Hands", durationSeconds: 6, prompt: "Close on Tay's hands pushing a glowing wireframe building into place above the desk.", firstFrameUrl: "/home/box/.theshow/media/board-a175e37274ff6439.jpg", lastFrameUrl: "/home/box/.theshow/media/board-498c58e7a5a8895d.jpg" },
  { index: 3, title: "Study", durationSeconds: 6, prompt: "Medium side view, Tay steps back and folds his arms, studying the model.", firstFrameUrl: "/home/box/.theshow/media/board-498c58e7a5a8895d.jpg", lastFrameUrl: "/home/box/.theshow/media/board-0a46f67c43ae9eaa.jpg" },
  { index: 4, title: "Resolve", durationSeconds: 6, prompt: "Front on, Tay nods slowly, satisfied, the model rotating between him and the camera.", firstFrameUrl: "/home/box/.theshow/media/board-0a46f67c43ae9eaa.jpg", lastFrameUrl: "/home/box/.theshow/media/board-4237e2a25d3a4bbb.jpg" },
];

const r: any = await client.callTool({
  name: "render_sequence",
  arguments: { shots: SHOTS, aspectRatio: "16:9", resolution: "720p", fadeDuration: 0, assemble: true, confirm: true, maxCostUsd: 5 },
}, undefined, { timeout: 580000 });
const p = JSON.parse(r.content[0].text);
console.log(JSON.stringify(p, null, 2).slice(0, 2000));
await client.close();
