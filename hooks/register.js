// polylogue for Claude Code: the agent of this session takes part in a polylogue session.
// The agent joins, sends and leaves with tools of its own. Every message names its
// recipients, and the person sees each one in their terminal as it comes. One addressed
// to the agent reaches it as a prompt from this plugin; any other goes with its next
// prompt as context, starting no turn. The person speaks into the session with
// /polylogue say. The plugin sends nothing for the agent, except which file it is
// editing, as activity. The agent and its person each leave on their own.
//
// A name is one identity: only the Claude Code session that joined under it reconnects
// to it, through the own link it keeps under its session's id. $.store is shared by
// every Claude Code session on the machine, so a link kept anywhere else would let a
// second session, such as the desktop app beside the terminal, become the same participant.

const RELAY = "https://agentwire.agentics.lwirth.com";
// A receive waits at most this long, within $.http.fetch's 30 seconds.
const WAIT = 25;
// Which file a participant is editing: facts, not speech, so a receive can leave them out.
const ACTIVITY = "application/vnd.polylogue.activity+json";
const EDITS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** The session taken part in, or null. */
let session = null;
/** Messages addressed to the agent, not yet given to it: they start a turn. */
let held = [];
/** Everything else said, not yet given to the agent: it goes with its next prompt. */
let context = [];
/** Sends, in order. */
let sending = Promise.resolve();
/** The pane that shows the session, where the band above the prompt doesn't. */
const PANE = "polylogue";
/** How many messages the pane keeps. */
const SHOWN = 40;

/** The session link, from a link or a token of the default relay. */
function parse(text) {
	const t = text.trim();
	if (/^https?:\/\/\S+\/s\/[\w-]+$/.test(t)) return t;
	if (/^[\w-]+$/.test(t)) return `${RELAY}/v2/s/${t}`;
	return null;
}

const isActivity = (x) => x.type.startsWith(ACTIVITY);
const isPresence = (x) =>
	x.type === "application/vnd.agentwire.join" ||
	x.type === "application/vnd.agentwire.leave";

/** A message's recipients, from the `to` parameter of its type; null where it names none, which means everyone. */
function recipients(x) {
	const to = /;\s*to=(?:"([^"]*)"|([^;\s]+))/i.exec(x.type);
	return to ? (to[1] ?? to[2]).split(/\s+/).filter(Boolean) : null;
}

/** Whether a message is addressed to `name`. */
function addressed(x, name) {
	const to = recipients(x);
	return to === null || to.includes("*") || to.includes(name);
}

/** A message as a line: its sender, its recipients, and what it says. */
function line(x) {
	const to = recipients(x);
	const whom = to === null || to.includes("*") ? "everyone" : to.join(", ");
	const payload =
		x.text ??
		`${x.size} bytes${x.filename ? `, ${x.filename}` : ""}, entry ${x.n}`;
	const said = x.type.startsWith("text/")
		? payload
		: `[${x.type.split(";")[0]}: ${payload}]`;
	return `${x.from} → ${whom}: ${said}`;
}

/** Closes every prompt from the session, since a prompt invites a report to the person, who already saw it. */
const REMINDER =
	"(Your person sees this too. Answer in the session if it asks you something, and tell your person only what is new to them, or nothing.)";

/** The type of a message in markdown to `to`. */
const speech = (to) => `text/markdown; charset=utf-8; to="${to.join(" ")}"`;

/** Joins `link` as `name`, through `me`, the own link this Claude Code session kept for it, where there is one. */
async function enter($, link, name, me) {
	const r = await $.http.fetch(
		me ? `${me}/join` : `${link}/join?as=${encodeURIComponent(name)}`,
		{ method: "POST" },
	);
	if (!r.ok) {
		const why =
			r.status === 409
				? `the name ${name} is taken in this session, by someone else or another Claude Code session`
				: `${r.status} ${r.text.trim()}`;
		return { error: why };
	}
	const joined = JSON.parse(r.text);
	return { name, me: joined.link, read: joined.read };
}

/** The link the plugin receives through: the agent's while it is in, else its person's. */
const listening = (s) => s.agent?.me ?? s.person?.me;

/** Keeps a message for the pane. */
function show(s, x) {
	s.shown.push(line(x));
	if (s.shown.length > SHOWN) s.shown.splice(0, s.shown.length - SHOWN);
}

/** Receives again after a pause that grows while the relay can't answer, up
 * to a minute, so that a relay that fails gets few requests. */
function retry($, s) {
	s.failures = (s.failures ?? 0) + 1;
	$.clock.after(Math.min(5000 * 2 ** (s.failures - 1), 60_000), () =>
		receive($, s),
	);
}

async function receive($, s) {
	if (session !== s) return;
	let r;
	try {
		// The first receive returns at once, so that who is in is known before the agent sends.
		const wait = s.listened ? WAIT : 0;
		r = await $.http.fetch(`${listening(s)}?after=${s.read}&wait=${wait}`);
	} catch {
		retry($, s);
		return;
	}
	if (session !== s) return;
	if (!r.ok) {
		// 409: another receive took over this name; 403 and 404: no longer in, or no session.
		if (r.status === 409 || r.status === 403 || r.status === 404) {
			session = null;
			$.ui.log(
				r.status === 409
					? `stopped taking part in ${s.link}: another process receives through the same link, such as this Claude Code session opened twice`
					: `no longer in ${s.link}: ${r.text.trim()}`,
			);
			$.ui.invalidate("ui.render");
			return;
		}
		retry($, s);
		return;
	}
	const lines = r.text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	s.presence = lines.pop()?.presence ?? s.presence;
	s.listened = true;
	s.failures = 0;
	const entries = lines.filter((x) => x.n > s.read);
	if (entries.length > 0) {
		s.read = entries.at(-1).n;
		for (const x of entries) {
			if (isActivity(x)) {
				try {
					s.activity[x.from] = JSON.parse(x.text).editing;
				} catch {}
			} else if (isPresence(x)) {
				// Who is in shows in the line above the prompt, and nowhere else.
			} else {
				show(s, x);
				if (x.from === s.agent?.name) {
					// The agent's own, which a receive through its person's link returns.
				} else if (
					s.agent &&
					addressed(x, s.agent.name) &&
					x.from !== s.person?.name
				) {
					held.push(x);
				} else {
					// The person sees it at once, unless they said it; the agent gets it with its next prompt.
					if (x.from !== s.person?.name) $.ui.log(line(x));
					if (s.agent) context.push(x);
				}
			}
		}
		if (held.length > 0) await submit($, s);
	}
	$.ui.invalidate("ui.render");
	$.clock.after(0, () => receive($, s));
}

/** Gives the messages addressed to the agent to it, as a prompt from this plugin, once it is idle. */
async function submit($, s) {
	const said = context.length
		? `\n\nSaid before, without waking you:\n${context.map(line).join("\n")}`
		: "";
	const text = `${held.map(line).join("\n\n")}${said}\n\n${REMINDER}`;
	const taken = held;
	held = [];
	context = [];
	let result;
	try {
		result = await $.prompt.submit({ text });
	} catch (error) {
		result = { drop: String(error) };
	}
	// Dropped, as after an interruption: given again once a turn ends.
	if (result?.drop) {
		held = [...taken, ...held];
		s.dropped = true;
	}
}

async function send($, me, body, type) {
	const r = await $.http.fetch(me, {
		method: "POST",
		headers: { "Content-Type": type },
		body,
	});
	return r.ok ? null : `${r.status} ${r.text.trim()}`;
}

async function join($, e) {
	const link = parse(e.session ?? "");
	if (!link) return "Give the session as its token or its full link.";
	const name = (e.name ?? "").trim();
	if (!name) return "Give the name to join under, as <person>/<agent>.";
	// Only this Claude Code session's own links are taken again, and only for the same session.
	const key = await kept($);
	const was = key ? await $.store.get(key) : null;
	const ours = was?.link === link ? (was.links ?? {}) : {};
	if (session && session.link !== link) await leaveAll($);
	const s =
		session?.link === link
			? session
			: {
					link,
					agent: null,
					person: null,
					read: 0,
					presence: {},
					activity: {},
					shown: [],
				};
	if (s.agent && s.agent.name !== name) await leaveAgent($, s);
	if (!s.agent) {
		const agent = await enter($, link, name, ours[name]);
		if (agent.error) return `Could not join: ${agent.error}.`;
		s.agent = { name, me: agent.me };
		if (!s.person) s.read = agent.read;
	}
	// The person takes part too, under their own name, so that they speak in the room themselves.
	const owner = name.includes("/") ? name.split("/")[0] : null;
	let personError = null;
	if (owner && !s.person) {
		const person = await enter($, link, owner, ours[owner]);
		if (person.error) personError = person.error;
		else s.person = { name: owner, me: person.me };
	}
	const fresh = session !== s;
	session = s;
	if (fresh) {
		held = [];
		context = [];
	}
	await remember($, s);
	s.listened = false;
	if (fresh) $.clock.after(0, () => receive($, s));
	await openPane($);
	$.ui.invalidate("ui.render");
	return [
		`Joined ${link} as ${name}.`,
		"Every message names its recipients, by name or * for everyone, and wakes only them:",
		"one addressed to you reaches you as a prompt from this plugin, and any other comes with your next prompt as context.",
		"Your person sees every message as it comes, so never restate or summarize one to them, nor what you did about it: where you have nothing new for them, end your turn with no text at all.",
		"Nothing needs a reply unless it asks for one: not an acknowledgement, and not your person's own message to the others.",
		"Your replies stay with your person: to say something in the session, use this plugin's send tool, addressed deliberately to participants who are in.",
		"The plugin also tells the others which file you are editing, as activity, never as speech.",
		s.person
			? `Your person is in the session as ${owner}, speaks there themselves with /polylogue say, and leaves with /polylogue leave.`
			: owner
				? `Your person could not join as ${owner} (${personError}), so they speak only through you.`
				: "Your name names no person, so your person speaks only through you.",
		"Your leave tool takes only you out of the session.",
	].join(" ");
}

/** Ends taking part, once neither the agent nor its person is in. */
async function end($, s) {
	if (s.agent || s.person) return;
	if (session === s) session = null;
	held = [];
	context = [];
	await forget($);
	await $.ui.close({ id: PANE }).catch(() => {});
}

async function leaveAgent($, s) {
	const agent = s.agent;
	if (!agent) return;
	s.agent = null;
	held = [];
	context = [];
	await $.http.fetch(`${agent.me}/leave`, { method: "POST" });
	await remember($, s);
	await end($, s);
	// The plugin goes on receiving through the person's link, so the person still sees the session.
	if (session === s) s.listened = false;
	$.ui.invalidate("ui.render");
}

async function leavePerson($, s) {
	const person = s.person;
	if (!person) return;
	s.person = null;
	await $.http.fetch(`${person.me}/leave`, { method: "POST" });
	await remember($, s);
	await end($, s);
	$.ui.invalidate("ui.render");
}

async function leaveAll($) {
	const s = session;
	if (!s) return;
	await leaveAgent($, s);
	await leavePerson($, s);
}

/** Who is in the session, by the presence the last receive returned. */
const present = (s) => Object.keys(s.presence ?? {});

/** The recipients among `to` who aren't in the session, `*` aside. */
const unknown = (s, to) =>
	to.filter((n) => n !== "*" && !present(s).includes(n));

/** Why a message to `to` can't go out, or null. */
function refusal(s, to) {
	if (to.length === 0) return "name its recipients, or * for everyone";
	const missing = unknown(s, to);
	if (missing.length === 0) return null;
	return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the session; in it are ${present(s).join(", ") || "nobody yet"}, or * for everyone`;
}

/** Opens the pane where the band above the prompt isn't drawn, as in the desktop app, or when asked. */
async function openPane($, asked = false) {
	if (!asked) {
		const r = await $.session.surfaces().catch(() => null);
		const surfaces = Array.isArray(r) ? r : (r?.value ?? []);
		const names = surfaces.map((x) =>
			typeof x === "string" ? x : (x?.kind ?? x?.surface ?? x?.name),
		);
		if (!names.some((n) => n && n !== "terminal")) return;
	}
	await $.ui.open({ id: PANE, title: "polylogue" }).catch(() => {});
}

/** The key under which this Claude Code session keeps the polylogue session it is in, since a resume, such as `claude --resume`, starts a new process with no memory of it. */
async function kept($) {
	const r = await $.session.id();
	const id = typeof r === "string" ? r : r?.value;
	return id ? `in:${id}` : null;
}

/** Keeps this Claude Code session's own links, so that it reconnects through them, after a resume or after leaving. */
async function remember($, s) {
	const key = await kept($);
	if (!key) return;
	const was = (await $.store.get(key)) ?? {};
	const links = was.link === s.link ? (was.links ?? {}) : {};
	for (const p of [s.agent, s.person]) if (p) links[p.name] = p.me;
	await $.store.set(key, {
		link: s.link,
		links,
		agent: s.agent,
		person: s.person,
	});
}

async function forget($) {
	const key = await kept($);
	if (!key) return;
	const was = await $.store.get(key);
	// The links stay, so that joining again takes the same names back; only being in ends.
	if (was) await $.store.set(key, { link: was.link, links: was.links ?? {} });
}

/** Takes part again in the session this Claude Code session was in before it was resumed. */
async function resume($) {
	if (session) return;
	const key = await kept($);
	const was = key ? await $.store.get(key) : null;
	if (!was?.agent && !was?.person) return;
	const s = {
		link: was.link,
		agent: null,
		person: null,
		read: 0,
		presence: {},
		activity: {},
		shown: [],
	};
	for (const role of ["agent", "person"]) {
		const p = was[role];
		if (!p) continue;
		const r = await $.http.fetch(`${p.me}/join`, { method: "POST" });
		if (r.ok) {
			s[role] = p;
			s.read = Math.max(s.read, JSON.parse(r.text).read);
		} else
			$.ui.log(
				`could not take part again in ${was.link} as ${p.name}: ${r.status} ${r.text.trim()}`,
			);
	}
	if (!s.agent && !s.person) {
		await $.store.set(key, { link: was.link, links: was.links ?? {} });
		return;
	}
	session = s;
	held = [];
	context = [];
	$.ui.log(
		`in ${s.link} again, as ${[s.agent?.name, s.person?.name].filter(Boolean).join(" and ")}`,
	);
	$.clock.after(0, () => receive($, s));
	await openPane($);
	$.ui.invalidate("ui.render");
}

/** The edited file's path within its Git repository, which every clone shares. */
async function within($, path) {
	const parts = path.split("/");
	for (let i = parts.length - 1; i > 0; i--) {
		const dir = parts.slice(0, i).join("/") || "/";
		if (await $.fs.exists(`${dir}/.git`)) return parts.slice(i).join("/");
	}
	return path;
}

export function register(on) {
	on("session.start", async ($, e, next) => {
		await $.tool.register({
			name: "join",
			description:
				"Join a polylogue session, given as a token or a full link, under a name of the form <person>/<agent>, such as ben/claude.",
			inputSchema: {
				type: "object",
				properties: {
					session: {
						type: "string",
						description: "The session's token or full link",
					},
					name: {
						type: "string",
						description: "Your name in the session, as <person>/<agent>",
					},
				},
				required: ["session", "name"],
			},
			isDeferred: false,
		});
		await $.tool.register({
			name: "send",
			description:
				"Say something in the polylogue session you joined, as markdown, to the participants it is for: it wakes only them, though everyone can read it.",
			inputSchema: {
				type: "object",
				properties: {
					to: {
						type: "array",
						items: { type: "string" },
						description: 'The recipients\' names, or ["*"] for everyone',
					},
					text: { type: "string" },
				},
				required: ["to", "text"],
			},
			isDeferred: false,
		});
		await $.tool.register({
			name: "leave",
			description:
				"Leave the polylogue session you joined. Only you leave: your person stays in until they leave with /polylogue leave.",
			inputSchema: { type: "object", properties: {} },
			isDeferred: false,
		});
		await $.command.register({
			name: "polylogue",
			description:
				"The polylogue session: say something in it, to names separated by commas or * for everyone, show it in a pane, or leave it yourself",
			argumentHint: "say <to> <text> | show | leave",
			immediate: true,
		});
		$.clock.after(0, () => resume($));
		return next(e);
	});

	on("tool.call", { tool: "mcp__polylogue__join" }, async ($, e) => ({
		result: await join($, e),
	}));

	on("tool.call", { tool: "mcp__polylogue__send" }, async ($, e) => {
		const s = session;
		if (!s?.agent)
			return { result: "Not in a polylogue session: join one first." };
		const to = (e.to ?? []).map((n) => n.trim()).filter(Boolean);
		const refused = refusal(s, to);
		if (refused) return { result: `Not sent: ${refused}.` };
		const type = speech(to);
		const failed = await send($, s.agent.me, e.text ?? "", type);
		if (failed) return { result: `Not sent: ${failed}` };
		show(s, { from: s.agent.name, type, text: e.text ?? "" });
		$.ui.invalidate("ui.render");
		return { result: "Sent." };
	});

	on("tool.call", { tool: "mcp__polylogue__leave" }, async ($) => {
		const s = session;
		if (!s?.agent) return { result: "Not in a polylogue session." };
		await leaveAgent($, s);
		return {
			result: s.person
				? `You left the session. Your person is still in, as ${s.person.name}, and leaves with /polylogue leave.`
				: "You left the session.",
		};
	});

	// Which file the agent is editing goes out as activity, as the edit starts.
	on("tool.call", { tool: EDITS }, async ($, e, next) => {
		const s = session;
		const path = e.file_path ?? e.notebook_path;
		if (s?.agent && path) {
			const editing = await within($, path);
			if (editing !== s.editing) {
				s.editing = editing;
				sending = sending
					.then(() =>
						s.agent
							? send($, s.agent.me, JSON.stringify({ editing }), ACTIVITY)
							: null,
					)
					.catch(() => {});
			}
		}
		return next(e);
	});

	on("command.run", { command: "polylogue" }, async ($, e) => {
		const args = e.args.trim();
		const s = session;
		if (args === "leave") {
			if (!s?.person)
				return {
					text: s
						? "You are not in the session yourself; your agent leaves with its leave tool."
						: "Not in a polylogue session.",
				};
			await leavePerson($, s);
			return {
				text: s.agent
					? `You left the polylogue session. Your agent is still in, as ${s.agent.name}.`
					: "You left the polylogue session.",
			};
		}
		if (args === "show") {
			if (!s) return { text: "Not in a polylogue session." };
			await openPane($, true);
			return {};
		}
		if (args === "say" || args.startsWith("say ")) {
			if (!s) return { text: "Not in a polylogue session." };
			if (!s.person)
				return {
					text: "You are not in the session yourself: tell your agent instead.",
				};
			const say = /^say\s+(\S+)\s+([\s\S]+)$/.exec(args);
			if (!say)
				return {
					text: "Say whom it is for: /polylogue say <names, separated by commas, or *> <text>",
				};
			const to = say[1].split(",").filter(Boolean);
			const refused = refusal(s, to);
			if (refused) return { text: `Not sent: ${refused}.` };
			const failed = await send($, s.person.me, say[2], speech(to));
			return failed ? { text: `Not sent: ${failed}` } : {};
		}
		const who = [s?.agent?.name, s?.person?.name].filter(Boolean).join(" and ");
		return {
			text: s
				? `In ${s.link} as ${who}. In it: ${present(s).join(", ")}.`
				: "Not in a polylogue session: your agent joins one with its join tool.",
		};
	});

	// What was said to others goes with the agent's next prompt, for it to read, starting no turn.
	on("prompt.submit", async ($, e, next) => {
		if (context.length === 0) return next(e);
		const said = context.map(line).join("\n\n");
		context = [];
		return next({
			...e,
			context: [
				...(e.context ?? []),
				`Said in the polylogue session since your last prompt, without waking you:\n\n${said}`,
			],
		});
	});

	// What an interrupted turn dropped goes in again once a turn ends.
	on("turn.complete", async ($, e, next) => {
		if (session?.dropped && !e.isAborted && !e.agentId && held.length > 0) {
			session.dropped = false;
			void submit($, session);
		}
		return next(e);
	});

	// The pane: who is in, and the latest messages, for where the band isn't drawn.
	on("ui.render", { component: "Pane" }, async ($, e, next) => {
		if (e.requestId !== PANE) return next(e);
		const s = session;
		const { Box, Text } = $.ui.resolve(e);
		if (!s) return Text({ children: ["Not in a polylogue session."] });
		const who = present(s)
			.map((n) => (s.activity[n] ? `${n} (${s.activity[n]})` : n))
			.join(", ");
		return Box({
			flexDirection: "column",
			children: [
				Text({
					key: "who",
					dimColor: true,
					children: [`In the session: ${who || "nobody yet"}`],
				}),
				...(s.shown.length === 0
					? [
							Text({
								key: "none",
								dimColor: true,
								children: ["Nothing said yet."],
							}),
						]
					: s.shown.map((l, i) => Text({ key: `m${i}`, children: [l] }))),
			],
		});
	});

	// One line above the prompt: who is in the session, and what each is editing.
	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const s = session;
		if (!s) return next(e);
		const { Box, Text } = $.ui.resolve(e);
		const mine = [s.agent?.name, s.person?.name];
		const others = Object.entries(s.presence ?? {}).filter(
			([name]) => !mine.includes(name),
		);
		const line = Text({
			children: [
				`polylogue · ${s.agent?.name ?? s.person?.name} with `,
				...(others.length === 0
					? ["nobody yet"]
					: others.flatMap(([name, p], i) => [
							...(i > 0 ? [", "] : []),
							Text({
								key: name,
								dimColor: !p.receiving && !s.activity[name],
								children: [
									s.activity[name] ? `${name} (${s.activity[name]})` : name,
								],
							}),
						])),
			],
		});
		const theirs = await next(e);
		return theirs
			? Box({ flexDirection: "column", children: [line, theirs] })
			: line;
	});
}
