// polylogue for Claude Code: the session's agent takes part in a polylogue session.
// What others send arrives as prompts, and what the agent writes goes out as entries.

const RELAY = "https://polylogue.agentics.lwirth.com";
// A receive waits at most this long, within $.http.fetch's 30 seconds.
const WAIT = 25;

/** The session taken part in, or null. */
let session = null;
/** Entries of others not yet given to the agent: they go with the next text. */
let held = [];
/** Sends, in order. */
let sending = Promise.resolve();
/** Whose agent this is, from the options: the agent joins under their name. */
let person = "";

/** The session link, from a link or a token of the default relay. */
function parse(text) {
	if (/^https?:\/\/\S+\/s\/[\w-]+$/.test(text)) return { link: text };
	if (/^[\w-]+$/.test(text)) return { link: `${RELAY}/v1/s/${text}` };
	return null;
}

/** A request on the agent's own link, which joining gave it. */
const at = (s, path = "", query = "") => `${s.me}${path}${query}`;

const isText = (x) => x.type.startsWith("text/");

/**
 * The prompt: what others said, as they said it, named by sender once more than one is in,
 * and every entry that is no text as a line of its own.
 */
function prompt(s, entries) {
	const others = Object.keys(s.presence ?? {}).filter(
		(name) => name !== s.name,
	);
	return entries
		.map((x) => {
			if (isText(x))
				return others.length > 1
					? `${x.from}: ${x.text ?? ""}`
					: (x.text ?? "");
			const payload =
				x.text !== undefined
					? x.text
					: `${x.size} bytes${x.filename ? `, ${x.filename}` : ""}: sh polylogue fetch ${s.link} ${x.n} <file>`;
			return `[polylogue: ${x.from} sent ${x.type}: ${payload}]`;
		})
		.join("\n\n");
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
		r = await $.http.fetch(at(s, "", `?after=${s.read}&wait=${WAIT}`));
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
	$.ui.invalidate("ui.render");
	s.failures = 0;
	const entries = lines.filter((x) => x.n > s.read);
	if (entries.length > 0) {
		s.read = entries.at(-1).n;
		held.push(...entries);
		if (held.some(isText)) await submit($, s);
	}
	$.clock.after(0, () => receive($, s));
}

/** Gives what others said to the agent as a prompt of the person's own, once it is idle. */
async function submit($, s) {
	const text = prompt(s, held);
	const taken = held;
	held = [];
	let result;
	try {
		result = await $.prompt.submit({ text, asUser: true });
	} catch (error) {
		result = { drop: String(error) };
	}
	// Dropped, as after an interruption: given again once a turn ends.
	if (result?.drop) {
		held = [...taken, ...held];
		s.dropped = true;
	}
}

async function send($, s, text) {
	const r = await $.http.fetch(at(s), {
		method: "POST",
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
		body: text,
	});
	if (!r.ok) $.ui.log(`not sent: ${r.status} ${r.text.trim()}`);
}

async function join($, args) {
	const found = parse(args);
	if (!found)
		return {
			text: "Give /polylogue a session link or token.",
		};
	if (session) await leave($);
	const name = person ? `${person}/claude` : "claude";
	// The own link of the last session joined, kept across Claude Code's
	// sessions: the name is taken for anyone else, so joining it again needs it.
	const last = await $.store.get("joined");
	const again = last?.link === found.link && last?.name === name;
	const r = await $.http.fetch(
		again
			? `${last.me}/join`
			: `${found.link}/join?as=${encodeURIComponent(name)}`,
		{ method: "POST" },
	);
	if (!r.ok) {
		const why =
			r.status === 409
				? `${name} is taken in this session: someone else joined under it`
				: `${r.status} ${r.text.trim()}`;
		return { text: `Could not join ${found.link}: ${why}` };
	}
	const joined = JSON.parse(r.text);
	const s = {
		...found,
		name,
		me: joined.link,
		read: joined.read,
		presence: {},
	};
	await $.store.set("joined", { link: s.link, name, me: s.me });
	session = s;
	held = [];
	$.clock.after(0, () => receive($, s));
	$.ui.invalidate("ui.render");
	// From the mod's own context: a command's hook can't start a turn.
	$.clock.after(0, () => introduce($, s));
	return {};
}

/** Tells the agent it takes part, and how. */
async function introduce($, s) {
	const name = s.name;
	await $.prompt.submit({
		text:
			`You take part in the polylogue session ${s.link} as "${name}"; this plugin joined it for you and runs it.` +
			" What the others send arrives as your prompts, and every reply you write goes to them as you write it." +
			" Receiving yourself would end the plugin's receive, and with it the plugin's part in the session; sending your replies yourself would send them twice." +
			" The polylogue script does what the plugin doesn't, such as sending or fetching a file:" +
			` it comes from \`curl -so polylogue ${RELAY}/polylogue\`, \`sh polylogue join ${s.me}\` sets it up once as you, and \`sh polylogue help\` lists the rest.` +
			" It is plain sh over curl, and its source is public at https://github.com/luiswirth/polylogue/blob/main/polylogue." +
			" That link is yours alone: whoever holds it speaks as you." +
			" The person leaves with /polylogue leave.",
	});
}

async function leave($) {
	const s = session;
	session = null;
	held = [];
	$.ui.invalidate("ui.render");
	if (s) await $.http.fetch(at(s, "/leave"), { method: "POST" });
}

export function register(on, options) {
	person = options.person?.trim() ?? "";
	on("session.start", async ($, e, next) => {
		await $.command.register({
			name: "polylogue",
			description: "Take part in a polylogue session, or leave it",
			argumentHint: "<link or token> | leave",
			immediate: true,
		});
		return next(e);
	});

	on("command.run", { command: "polylogue" }, async ($, e) => {
		const args = e.args.trim();
		if (args === "leave") {
			if (!session) return { text: "Not in a polylogue session." };
			await leave($);
			return { text: "Left the polylogue session." };
		}
		if (!args)
			return {
				text: session
					? `In ${session.link} as ${session.name}.`
					: "Not in a polylogue session.",
			};
		return join($, args);
	});

	// What the agent writes goes out, step by step, as it writes it.
	on("turn.step", async function* ($, e, next) {
		const result = yield* next(e);
		const s = session;
		if (s && !e.agentId && result.answer.trim()) {
			sending = sending.then(() => send($, s, result.answer)).catch(() => {});
		}
		return result;
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

	// One line above the prompt: the session, and who is in it.
	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		if (!session) return next(e);
		const { Box, Text } = $.ui.resolve(e);
		const others = Object.entries(session.presence ?? {}).filter(
			([name]) => name !== session.name,
		);
		const line = Text({
			children: [
				`polylogue · ${session.name} with `,
				...(others.length === 0
					? ["nobody yet"]
					: others.flatMap(([name, p], i) => [
							...(i > 0 ? [", "] : []),
							Text({ key: name, dimColor: !p.receiving, children: [name] }),
						])),
			],
		});
		const theirs = await next(e);
		return theirs
			? Box({ flexDirection: "column", children: [line, theirs] })
			: line;
	});
}
