// polylogue for Claude Code: the agent of this session takes part in a polylogue session.
// The agent joins, sends and leaves with tools of its own. Every message names its
// recipients, and the person sees each one in their terminal as it comes. One addressed
// to the agent reaches it as a prompt from this plugin; any other goes with its next
// prompt as context, starting no turn. The person speaks into the session with
// /polylogue say. The plugin sends nothing for the agent, except which file it is
// editing, as activity.

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

/** Joins `link` as `name`, again with the own link kept from before where there is one. */
async function enter($, link, name) {
	const kept = (await $.store.get("joined")) ?? {};
	const me = kept.link === link ? kept.links?.[name] : undefined;
	const r = await $.http.fetch(
		me ? `${me}/join` : `${link}/join?as=${encodeURIComponent(name)}`,
		{ method: "POST" },
	);
	if (!r.ok) {
		const why =
			r.status === 409
				? `the name ${name} is taken in this session`
				: `${r.status} ${r.text.trim()}`;
		return { error: why };
	}
	const joined = JSON.parse(r.text);
	const links = kept.link === link ? (kept.links ?? {}) : {};
	await $.store.set("joined", {
		link,
		links: { ...links, [name]: joined.link },
	});
	return { me: joined.link, read: joined.read };
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
		r = await $.http.fetch(`${s.me}?after=${s.read}&wait=${WAIT}`);
	} catch {
		retry($, s);
		return;
	}
	if (session !== s) return;
	if (!r.ok) {
		// 409: another receive took over this name; 403 and 404: no longer in, or no session.
		if (r.status === 409 || r.status === 403 || r.status === 404) {
			session = null;
			$.ui.log(`left ${s.link}: ${r.text.trim()}`);
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
			} else if (addressed(x, s.name) && x.from !== s.person?.name) {
				held.push(x);
			} else {
				// The person sees it at once, unless they said it; the agent gets it with its next prompt.
				if (x.from !== s.person?.name) $.ui.log(line(x));
				context.push(x);
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
	if (session) await leave($);
	const agent = await enter($, link, name);
	if (agent.error) return `Could not join: ${agent.error}.`;
	// The person takes part too, under their own name, so that they speak in the room themselves.
	const owner = name.includes("/") ? name.split("/")[0] : null;
	const person = owner ? await enter($, link, owner) : null;
	const s = {
		link,
		name,
		me: agent.me,
		read: agent.read,
		person: person?.me ? { name: owner, me: person.me } : null,
		presence: {},
		activity: {},
	};
	session = s;
	held = [];
	context = [];
	await remember($, s);
	$.clock.after(0, () => receive($, s));
	$.ui.invalidate("ui.render");
	return [
		`Joined ${link} as ${name}.`,
		"Every message names its recipients, by name or * for everyone, and wakes only them:",
		"one addressed to you reaches you as a prompt from this plugin, and any other comes with your next prompt as context.",
		"Your person sees every message in their terminal as it comes, so never restate or summarize one to them, nor what you did about it: where you have nothing new for them, end your turn with no text at all.",
		"Nothing needs a reply unless it asks for one: not an acknowledgement, and not your person's own message to the others.",
		"Your replies stay with your person: to say something in the session, use this plugin's send tool, addressed deliberately.",
		"The plugin also tells the others which file you are editing, as activity, never as speech.",
		s.person
			? `Your person is in the session as ${owner}, and speaks there themselves with /polylogue say.`
			: owner
				? `Your person could not join as ${owner} (${person.error}), so they speak only through you.`
				: "Your name names no person, so your person speaks only through you.",
		"Leave with this plugin's leave tool when your person is done.",
	].join(" ");
}

async function leave($) {
	const s = session;
	session = null;
	held = [];
	context = [];
	$.ui.invalidate("ui.render");
	if (!s) return;
	await forget($);
	await $.http.fetch(`${s.me}/leave`, { method: "POST" });
	if (s.person) await $.http.fetch(`${s.person.me}/leave`, { method: "POST" });
}

/** The key under which this Claude Code session keeps the polylogue session it is in, since a resume, such as `claude --resume`, starts a new process with no memory of it. */
async function kept($) {
	const r = await $.session.id();
	const id = typeof r === "string" ? r : r?.value;
	return id ? `in:${id}` : null;
}

async function remember($, s) {
	const key = await kept($);
	if (key)
		await $.store.set(key, {
			link: s.link,
			name: s.name,
			me: s.me,
			person: s.person,
		});
}

async function forget($) {
	const key = await kept($);
	if (key) await $.store.delete(key);
}

/** Takes part again in the session this Claude Code session was in before it was resumed. */
async function resume($) {
	if (session) return;
	const key = await kept($);
	const was = key ? await $.store.get(key) : null;
	if (!was) return;
	const r = await $.http.fetch(`${was.me}/join`, { method: "POST" });
	if (!r.ok) {
		// No longer anyone's link, or no session: nothing to take part in again.
		if ([403, 404, 410].includes(r.status)) await $.store.delete(key);
		$.ui.log(
			`could not take part again in ${was.link}: ${r.status} ${r.text.trim()}`,
		);
		return;
	}
	if (was.person)
		await $.http.fetch(`${was.person.me}/join`, { method: "POST" });
	const s = {
		link: was.link,
		name: was.name,
		me: was.me,
		read: JSON.parse(r.text).read,
		person: was.person,
		presence: {},
		activity: {},
	};
	session = s;
	held = [];
	context = [];
	$.ui.log(`in ${s.link} again, as ${s.name}`);
	$.clock.after(0, () => receive($, s));
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
			description: "Leave the polylogue session you joined, with your person.",
			inputSchema: { type: "object", properties: {} },
			isDeferred: false,
		});
		await $.command.register({
			name: "polylogue",
			description:
				"The polylogue session: say something in it, to names separated by commas or * for everyone, or leave it",
			argumentHint: "say <to> <text> | leave",
			immediate: true,
		});
		$.clock.after(0, () => resume($));
		return next(e);
	});

	on("tool.call", { tool: "mcp__polylogue__join" }, async ($, e) => ({
		result: await join($, e),
	}));

	on("tool.call", { tool: "mcp__polylogue__send" }, async ($, e) => {
		if (!session)
			return { result: "Not in a polylogue session: join one first." };
		const to = (e.to ?? []).map((n) => n.trim()).filter(Boolean);
		if (to.length === 0)
			return { result: "Not sent: name its recipients, or * for everyone." };
		const failed = await send($, session.me, e.text ?? "", speech(to));
		return { result: failed ? `Not sent: ${failed}` : "Sent." };
	});

	on("tool.call", { tool: "mcp__polylogue__leave" }, async ($) => {
		if (!session) return { result: "Not in a polylogue session." };
		await leave($);
		return { result: "Left the session, with your person." };
	});

	// Which file the agent is editing goes out as activity, as the edit starts.
	on("tool.call", { tool: EDITS }, async ($, e, next) => {
		const s = session;
		const path = e.file_path ?? e.notebook_path;
		if (s && path) {
			const editing = await within($, path);
			if (editing !== s.editing) {
				s.editing = editing;
				sending = sending
					.then(() => send($, s.me, JSON.stringify({ editing }), ACTIVITY))
					.catch(() => {});
			}
		}
		return next(e);
	});

	on("command.run", { command: "polylogue" }, async ($, e) => {
		const args = e.args.trim();
		if (args === "leave") {
			if (!session) return { text: "Not in a polylogue session." };
			await leave($);
			return { text: "Left the polylogue session." };
		}
		if (args === "say" || args.startsWith("say ")) {
			if (!session) return { text: "Not in a polylogue session." };
			if (!session.person)
				return {
					text: "You are not in the session yourself: tell your agent instead.",
				};
			const say = /^say\s+(\S+)\s+([\s\S]+)$/.exec(args);
			if (!say)
				return {
					text: "Say whom it is for: /polylogue say <names, separated by commas, or *> <text>",
				};
			const to = say[1].split(",").filter(Boolean);
			const failed = await send($, session.person.me, say[2], speech(to));
			return failed ? { text: `Not sent: ${failed}` } : {};
		}
		return {
			text: session
				? `In ${session.link} as ${session.name}${session.person ? ` and ${session.person.name}` : ""}.`
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

	// One line above the prompt: who is in the session, and what each is editing.
	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const s = session;
		if (!s) return next(e);
		const { Box, Text } = $.ui.resolve(e);
		const mine = [s.name, s.person?.name];
		const others = Object.entries(s.presence ?? {}).filter(
			([name]) => !mine.includes(name),
		);
		const line = Text({
			children: [
				`polylogue · ${s.name} with `,
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
