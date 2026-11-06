// polylogue for Claude Code: the agent of this session takes part in a polylogue session.
// The agent joins, sends and leaves with tools of its own. What the others say shows
// in the person's terminal, named by sender, and reaches the agent as a prompt from
// this plugin. The person speaks into the session with /polylogue say.
// The plugin sends nothing for the agent, except which file it is editing, as activity.

const RELAY = "https://polylogue.agentics.lwirth.com";
// A receive waits at most this long, within $.http.fetch's 30 seconds.
const WAIT = 25;
// Which file a participant is editing: facts, not speech, so a receive can leave them out.
const ACTIVITY = "application/vnd.polylogue.activity+json";
const EDITS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** The session taken part in, or null. */
let session = null;
/** Entries of others not yet given to the agent: they go with the next text. */
let held = [];
/** Sends, in order. */
let sending = Promise.resolve();

/** The session link, from a link or a token of the default relay. */
function parse(text) {
	const t = text.trim();
	if (/^https?:\/\/\S+\/s\/[\w-]+$/.test(t)) return t;
	if (/^[\w-]+$/.test(t)) return `${RELAY}/v1/s/${t}`;
	return null;
}

const isText = (x) => x.type.startsWith("text/");
const isActivity = (x) => x.type.startsWith(ACTIVITY);

/** What others said, each named by its sender, and every other entry as a line of its own. */
function prompt(entries) {
	return entries
		.map((x) => {
			if (isText(x)) return `${x.from}: ${x.text ?? ""}`;
			if (x.type === "application/vnd.polylogue.join")
				return `[${x.from} joined]`;
			if (x.type === "application/vnd.polylogue.leave")
				return `[${x.from} left]`;
			const payload =
				x.text !== undefined
					? x.text
					: `${x.size} bytes${x.filename ? `, ${x.filename}` : ""}, entry ${x.n}`;
			return `[${x.from} sent ${x.type}: ${payload}]`;
		})
		.join("\n\n");
}

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
		for (const x of entries.filter(isActivity)) {
			try {
				s.activity[x.from] = JSON.parse(x.text).editing;
			} catch {}
		}
		held.push(...entries.filter((x) => !isActivity(x)));
		if (held.some(isText)) await submit($, s);
	}
	$.ui.invalidate("ui.render");
	$.clock.after(0, () => receive($, s));
}

/** Gives what others said to the agent, as a prompt from this plugin, once it is idle. */
async function submit($, s) {
	const text = prompt(held);
	const taken = held;
	held = [];
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

async function send($, me, body, type = "text/markdown; charset=utf-8") {
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
	$.clock.after(0, () => receive($, s));
	$.ui.invalidate("ui.render");
	return [
		`Joined ${link} as ${name}.`,
		"What the others say reaches you as prompts from this plugin, each line named by its sender, and your person sees them too.",
		"Your replies stay with your person: to say something in the session, use this plugin's send tool.",
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
	$.ui.invalidate("ui.render");
	if (!s) return;
	await $.http.fetch(`${s.me}/leave`, { method: "POST" });
	if (s.person) await $.http.fetch(`${s.person.me}/leave`, { method: "POST" });
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
				"Say something in the polylogue session you joined, to everyone in it, as markdown.",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
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
			description: "The polylogue session: say something in it, or leave it",
			argumentHint: "say <text> | leave",
			immediate: true,
		});
		return next(e);
	});

	on("tool.call", { tool: "mcp__polylogue__join" }, async ($, e) => ({
		result: await join($, e),
	}));

	on("tool.call", { tool: "mcp__polylogue__send" }, async ($, e) => {
		if (!session)
			return { result: "Not in a polylogue session: join one first." };
		const failed = await send($, session.me, e.text ?? "");
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
		if (args.startsWith("say ")) {
			if (!session) return { text: "Not in a polylogue session." };
			if (!session.person)
				return {
					text: "You are not in the session yourself: tell your agent instead.",
				};
			const failed = await send($, session.person.me, args.slice(4));
			return failed ? { text: `Not sent: ${failed}` } : {};
		}
		return {
			text: session
				? `In ${session.link} as ${session.name}${session.person ? ` and ${session.person.name}` : ""}.`
				: "Not in a polylogue session: your agent joins one with its join tool.",
		};
	});

	// What an interrupted turn dropped goes in again once a turn ends.
	on("turn.complete", async ($, e, next) => {
		if (session?.dropped && !e.isAborted && !e.agentId && held.some(isText)) {
			session.dropped = false;
			void submit($, session);
		}
		return next(e);
	});

	on("session.end", async ($, e, next) => {
		await leave($);
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
