import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
	BindingUpdateSchema,
	DeliveryStatusSchema,
	EgressPolicyUpdateSchema,
	SlackOutboxStateSchema,
} from "../domain.js";
import { OperatorClient } from "./client.js";

export interface OperatorDashboardConfig {
	port: number;
}

export class OperatorDashboardServer {
	private server: Server | null = null;
	private readonly csrfToken = randomBytes(32).toString("base64url");

	constructor(
		private readonly operator: OperatorClient,
		private readonly config: OperatorDashboardConfig,
	) {}

	async start(): Promise<{ host: "127.0.0.1"; port: number; url: string }> {
		if (this.server) throw new Error("operator dashboard already started");
		this.server = createServer((request, response) => {
			void this.route(request, response).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				json(response, message === "forbidden" ? 403 : 400, { error: message });
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.config.port, "127.0.0.1", resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("operator dashboard did not bind TCP");
		const url = `http://127.0.0.1:${address.port}`;
		return { host: "127.0.0.1", port: address.port, url };
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const current = this.server;
		this.server = null;
		await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
	}

	private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const host = requireLoopbackHost(request.headers.host);
		const url = new URL(request.url ?? "/", `http://${host}`);
		if (request.method === "GET" && url.pathname === "/") {
			return html(response, dashboardHtml(this.csrfToken));
		}
		if (request.method === "GET" && url.pathname === "/api/status") {
			const actor = url.searchParams.get("actor") || undefined;
			return json(response, 200, await this.operator.status({ ...(actor ? { actor } : {}) }));
		}
		if (request.method === "GET" && url.pathname === "/api/deliveries") {
			const actor = url.searchParams.get("actor") || undefined;
			const rawStatus = url.searchParams.get("status") || undefined;
			const status = rawStatus ? DeliveryStatusSchema.parse(rawStatus) : undefined;
			const rawLimit = url.searchParams.get("limit") ?? "50";
			const limit = Number(rawLimit);
			if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid limit");
			return json(response, 200, await this.operator.deliveries({
				...(actor ? { actor } : {}),
				...(status ? { status } : {}),
				limit,
			}));
		}
		if (request.method === "GET" && url.pathname === "/api/outbox") {
			const rawState = url.searchParams.get("state") || undefined;
			const state = rawState ? SlackOutboxStateSchema.parse(rawState) : undefined;
			return json(response, 200, await this.operator.outbox({
				...(state ? { state } : {}),
				limit: 50,
			}));
		}
		if (request.method === "POST" && url.pathname === "/api/bind") {
			this.requireMutationAuthority(request, host);
			const body = await readJson(request);
			const actor = requiredString(body.actor, "actor");
			const update = BindingUpdateSchema.parse({
				sessionId: body.sessionId,
				...(body.providerSurface ? { providerSurface: body.providerSurface } : {}),
				...(body.providerVersion ? { providerVersion: body.providerVersion } : {}),
			});
			return json(response, 200, await this.operator.bind(actor, update));
		}
		if (request.method === "POST" && url.pathname === "/api/egress") {
			this.requireMutationAuthority(request, host);
			const body = await readJson(request);
			const actor = requiredString(body.actor, "actor");
			const policy = EgressPolicyUpdateSchema.parse({
				policy: body.policy,
				channelIds: body.channelId ? [body.channelId] : [],
			});
			return json(response, 200, await this.operator.setEgressPolicy(actor, policy));
		}
		return json(response, 404, { error: "not_found" });
	}

	private requireMutationAuthority(request: IncomingMessage, host: string): void {
		if (request.headers.origin !== `http://${host}`) throw new Error("forbidden");
		if (request.headers["x-hive-csrf"] !== this.csrfToken) throw new Error("forbidden");
		if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("forbidden");
	}
}

function requireLoopbackHost(host: string | undefined): string {
	if (!host) throw new Error("forbidden");
	let parsed: URL;
	try {
		parsed = new URL(`http://${host}`);
	} catch {
		throw new Error("forbidden");
	}
	if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("forbidden");
	return host;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += value.length;
		if (length > 64_000) throw new Error("payload_too_large");
		chunks.push(value);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name}`);
	return value;
}

function securityHeaders(contentType: string): Record<string, string> {
	return {
		"cache-control": "no-store",
		"content-security-policy": [
			"default-src 'self'",
			"script-src 'unsafe-inline'",
			"style-src 'unsafe-inline'",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'none'",
			"form-action 'self'",
		].join("; "),
		"content-type": contentType,
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
	};
}

function html(response: ServerResponse, value: string): void {
	response.writeHead(200, {
		...securityHeaders("text/html; charset=utf-8"),
		"content-length": Buffer.byteLength(value),
	});
	response.end(value);
}

function json(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		...securityHeaders("application/json; charset=utf-8"),
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function dashboardHtml(csrfToken: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hive operator</title>
<style>
:root{color-scheme:dark;--bg:#10130f;--panel:#1a1f19;--line:#354035;--ink:#edf4e8;--muted:#9cab99;--ok:#82d98b;--warn:#f1c96a;--bad:#ef8f82;--accent:#99c7ff;font:15px/1.45 ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}main{max-width:1180px;margin:auto;padding:32px 20px 80px}header{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:24px}h1{font-size:34px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0 0 12px}.stamp{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:24px}.card,section{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}.card strong{font-size:18px}.meta{color:var(--muted);margin-top:6px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}code{color:var(--accent)}form{display:grid;grid-template-columns:1fr 1.4fr 1fr 1fr auto auto;gap:10px;align-items:end}label{color:var(--muted);font-size:12px}input,select,button{width:100%;margin-top:5px;border:1px solid var(--line);border-radius:10px;background:#111610;color:var(--ink);padding:10px}button{cursor:pointer;background:#253b27;border-color:#426c47;font-weight:700}.secondary{background:#352725;border-color:#70433d}.message{min-height:24px;color:var(--muted);margin-top:10px}@media(max-width:850px){form{grid-template-columns:1fr}header{align-items:start;flex-direction:column}section{overflow:auto}}
</style>
</head>
<body><main>
<header><div><h1>Hive</h1><div class="stamp">collaboration control surface</div></div><div id="updated" class="stamp">Loading…</div></header>
<h2>Edges and actors</h2><div id="cards" class="grid"></div>
<section><h2>Bind a session</h2><form id="bind"><label>Actor<input name="actor" required autocomplete="off"></label><label>Session ID<input name="sessionId" required autocomplete="off"></label><label>Surface<input name="providerSurface" placeholder="app-server"></label><label>Version<input name="providerVersion" placeholder="current"></label><button type="submit">Bind</button><button type="button" class="secondary" id="unbind">Unbind</button></form><div id="message" class="message"></div></section>
<section style="margin-top:24px"><h2>Slack completion egress</h2><form id="egress"><label>Actor<input name="actor" required autocomplete="off"></label><label>Policy<select name="policy"><option value="receipt_only">Receipt only</option><option value="assistant_text">Assistant text</option></select></label><label>Exact channel ID<input name="channelId" placeholder="C…" autocomplete="off"></label><button type="submit">Apply</button></form><div class="message">Assistant text remains inert, bounded, and restricted to this exact channel.</div></section>
<section style="margin-top:24px"><h2>Recent deliveries</h2><table><thead><tr><th>ID</th><th>Actor</th><th>Status</th><th>Attempts</th><th>Reason</th><th>Updated</th></tr></thead><tbody id="deliveries"></tbody></table></section>
<section style="margin-top:24px"><h2>Slack outbox</h2><table><thead><tr><th>ID</th><th>State</th><th>Kind</th><th>Delivery</th><th>Thread</th><th>Attempts</th><th>Error</th></tr></thead><tbody id="outbox"></tbody></table></section>
<section style="margin-top:24px"><h2>Ignored or unroutable ingress</h2><table><thead><tr><th>ID</th><th>Reason</th><th>Channel / thread</th><th>Time</th></tr></thead><tbody id="ingress"></tbody></table></section>
</main><script>
const csrf=${JSON.stringify(csrfToken)};
const esc=(v)=>String(v??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function refresh(){const [status,deliveries,outbox]=await Promise.all([fetch("/api/status").then(ok),fetch("/api/deliveries?limit=50").then(ok),fetch("/api/outbox").then(ok)]);const outboxAttention=status.outboxCounts.ambiguous+status.outboxCounts.dead;const slackAttention=status.slack.ready?0:1;document.querySelector("#updated").innerHTML=((outboxAttention+slackAttention)?'<span class="warn">ATTENTION · '+(outboxAttention?'Slack outbox '+outboxAttention:'Slack connection')+'</span> · ':'')+'Updated '+new Date(status.generatedAt).toLocaleTimeString();document.querySelector("#cards").innerHTML=['<div class="card"><strong class="'+(status.slack.ready?'ok':'warn')+'">Slack</strong><div class="meta">socket '+esc(status.slack.socket)+' · bot '+esc(status.slack.bot)+'</div></div>',...status.edges.map(e=>'<div class="card"><strong class="'+(e.connected?"ok":"warn")+'">'+esc(e.edgeId)+'</strong><div class="meta">'+(e.enabled?"enabled":"disabled")+' · '+(e.connected?"connected":"stale")+'<br>'+esc(e.lastSeenAt??"never seen")+'</div></div>'),...status.actors.map(a=>'<div class="card"><strong class="'+(a.warnings.length?"warn":"ok")+'">'+esc(a.subscription.actor)+'</strong><div class="meta">'+esc(a.subscription.provider)+'/'+esc(a.subscription.providerSurface)+' '+esc(a.subscription.providerVersion)+'<br>session <code>'+esc(a.subscription.sessionId??"unbound")+'</code><br>'+esc(a.subscription.homeEdge)+' · '+esc(a.subscription.wakePolicy)+' · '+esc(a.subscription.permissionProfile)+'<br>egress '+esc(a.subscription.egressPolicy)+(a.subscription.egressChannelIds.length?' · '+a.subscription.egressChannelIds.map(esc).join(', '):'')+'<br>live '+(a.livePresence?(a.livePresence.ownerLoaded?'connected via ':'unavailable via ')+esc(a.livePresence.transport):'not observed')+a.warnings.map(w=>'<br><span class="warn">! '+esc(w)+'</span>').join("")+'</div></div>')].join("");document.querySelector("#deliveries").innerHTML=deliveries.map(d=>'<tr><td>#'+d.id+'</td><td>'+esc(d.actor)+'</td><td>'+esc(d.status)+(d.availableAt?'<br><span class="meta">retry '+esc(d.availableAt)+'</span>':'')+'</td><td>'+d.attempts+'</td><td>'+esc(d.reasons[0]?.code??"")+'</td><td>'+new Date(d.updatedAt).toLocaleTimeString()+'</td></tr>').join("")||'<tr><td colspan="6" class="meta">No deliveries</td></tr>';document.querySelector("#outbox").innerHTML=outbox.map(o=>'<tr><td>#'+o.id+'</td><td class="'+((o.state==='ambiguous'||o.state==='dead')?'warn':'')+'">'+esc(o.state)+'</td><td>'+esc(o.kind)+'</td><td>'+esc(o.deliveryId??'—')+'</td><td>'+esc(o.channelId)+' / '+esc(o.threadTs)+'</td><td>'+o.attempts+'</td><td>'+esc(o.errorCode??'')+'</td></tr>').join("")||'<tr><td colspan="7" class="meta">No Slack egress</td></tr>';document.querySelector("#ingress").innerHTML=status.recentIngressDiagnostics.map(d=>'<tr><td>#'+d.id+'</td><td>'+esc(d.reason)+'</td><td>'+esc(d.channelId)+' / '+esc(d.threadTs)+'</td><td>'+new Date(d.createdAt).toLocaleTimeString()+'</td></tr>').join("")||'<tr><td colspan="4" class="meta">No ignored ingress</td></tr>'}
async function ok(r){if(!r.ok)throw new Error(await r.text());return r.json()}
async function mutate(sessionId){const f=new FormData(document.querySelector("#bind"));const body={actor:f.get("actor"),sessionId,...(f.get("providerSurface")?{providerSurface:f.get("providerSurface")} :{}),...(f.get("providerVersion")?{providerVersion:f.get("providerVersion")} :{})};const result=await fetch("/api/bind",{method:"POST",headers:{"content-type":"application/json","x-hive-csrf":csrf},body:JSON.stringify(body)}).then(ok);document.querySelector("#message").textContent=result.actor+" is "+(result.sessionId?"bound to "+result.sessionId:"unbound")+"; authority unchanged.";await refresh()}
document.querySelector("#bind").addEventListener("submit",e=>{e.preventDefault();mutate(new FormData(e.currentTarget).get("sessionId")).catch(show)});document.querySelector("#unbind").addEventListener("click",()=>mutate(null).catch(show));function show(e){document.querySelector("#message").textContent=e.message}refresh().catch(show);setInterval(()=>refresh().catch(show),5000);
document.querySelector("#egress").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);fetch("/api/egress",{method:"POST",headers:{"content-type":"application/json","x-hive-csrf":csrf},body:JSON.stringify({actor:f.get("actor"),policy:f.get("policy"),channelId:f.get("channelId")||null})}).then(ok).then(refresh).catch(show)});
</script></body></html>`;
}
