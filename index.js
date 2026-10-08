require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { Client, Events, GatewayIntentBits, ChannelType, Partials, AttachmentBuilder } = require('discord.js');

const BOTS_CONFIG_PATH = './bots.config.json';

if (!fs.existsSync(BOTS_CONFIG_PATH)) {
	console.error(`Missing ${BOTS_CONFIG_PATH} — copy bots.config.example.json and fill in your bots.`);
	process.exit(1);
}

const bots = JSON.parse(fs.readFileSync(BOTS_CONFIG_PATH, 'utf8'));

const LARAVEL_API_URL = process.env.LARAVEL_VERA_API_URL || 'https://laravel-vera.test/api';
const LARAVEL_API_TOKEN = process.env.DISCORD_API_TOKEN;
const CONFIG_REFRESH_INTERVAL_MS = 60_000;
const TYPING_REFRESH_INTERVAL_MS = 8_000;
const MESSAGE_CHUNK_SIZE = 1900;
const MAX_BOT_REPLY_CHAIN = 2;
const LOG_FILE_PATH = './discord-api.log';

const CREATE_VIDEO_PATTERN = /^\/create-video(?:\s|$)/i;
const CONNECTION_FAILED_MESSAGE = 'Connection failed. Try again.';
const MEGABYTE = 1024 * 1024;
const DM_UPLOAD_LIMIT_BYTES = 10 * MEGABYTE;
const UPLOAD_LIMIT_BYTES_BY_TIER = {
	0: 10 * MEGABYTE,
	1: 10 * MEGABYTE,
	2: 50 * MEGABYTE,
	3: 100 * MEGABYTE,
};
const SHRINK_AUDIO_KBPS = 128;
const SHRINK_FALLBACK_HEIGHT = 480;

const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = {
	'audio/ogg': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/webm': 'webm',
	'audio/mp4': 'mp4',
};

const botsByAssistantId = new Map();

// Shared across every bot so at most one request to Laravel/the LLM provider is ever in
// flight at a time, regardless of how many bots are running or how much they message each other.
let requestQueue = Promise.resolve();

function enqueue(task) {
	const run = requestQueue.then(task, task);
	requestQueue = run.catch(() => {});
	return run;
}

function logError(context, { message, code = null, stack = null } = {}) {
	const entry = {
		timestamp: new Date().toISOString(),
		context,
		message,
		code,
		stack,
	};

	console.error(`[${context}] ${message}${code ? ` (${code})` : ''}`);

	fs.appendFile(LOG_FILE_PATH, JSON.stringify(entry) + '\n', (writeErr) => {
		if (writeErr) console.error(`Failed to write to ${LOG_FILE_PATH}: ${writeErr.message}`);
	});
}

function laravelHeaders(extra = {}) {
	return {
		Authorization: `Bearer ${LARAVEL_API_TOKEN}`,
		Accept: 'application/json',
		...extra,
	};
}

async function fetchChannelConfig(assistantId) {
	const res = await fetch(`${LARAVEL_API_URL}/assistants/${assistantId}/settings`, {
		headers: laravelHeaders(),
	});

	if (!res.ok) {
		throw new Error(`settings fetch failed: ${res.status}`);
	}

	const data = await res.json();
	const config = new Map();

	for (const channel of data.discord_channels ?? []) {
		config.set(channel.channel_id, channel.trigger_mode);
	}

	return config;
}

async function downloadAttachmentAsBase64(url) {
	const res = await fetch(url);
	const buffer = await res.arrayBuffer();
	return Buffer.from(buffer).toString('base64');
}

async function downloadAttachmentAsBuffer(url) {
	const res = await fetch(url);
	const buffer = await res.arrayBuffer();
	return Buffer.from(buffer);
}

function normalizeForNameMatch(str) {
	return str.toLowerCase().replace(/[\s_.-]+/g, '');
}

function nameMatchTerms(username) {
	return username
		.toLowerCase()
		.split(/[\s_.-]+/)
		.filter(Boolean);
}

async function rejectionMessage(res) {
	const body = await res.text().catch(() => '');

	try {
		const { message } = JSON.parse(body);
		if (typeof message === 'string' && message.trim() !== '') {
			return { body, message };
		}
	} catch {
		// Not JSON: the body is still logged below, and the user gets the generic message.
	}

	return { body, message: CONNECTION_FAILED_MESSAGE };
}

function postReply(channel, replyToMessageId, payload) {
	return channel.send({
		...payload,
		...(replyToMessageId ? { reply: { messageReference: replyToMessageId, failIfNotExists: false } } : {}),
	});
}

function uploadLimitFor(channel) {
	if (channel.type === ChannelType.DM) {
		return DM_UPLOAD_LIMIT_BYTES;
	}

	return UPLOAD_LIMIT_BYTES_BY_TIER[channel.guild?.premiumTier] ?? UPLOAD_LIMIT_BYTES_BY_TIER[0];
}

async function encodeVideo(inputPath, outputPath, videoKbps, height = null) {
	await execFileAsync('ffmpeg', [
		'-y',
		'-i', inputPath,
		...(height ? ['-vf', `scale=-2:${height}`] : []),
		'-c:v', 'libx264',
		'-b:v', `${videoKbps}k`,
		'-maxrate', `${videoKbps}k`,
		'-bufsize', `${videoKbps * 2}k`,
		'-c:a', 'aac',
		'-b:a', `${SHRINK_AUDIO_KBPS}k`,
		'-movflags', '+faststart',
		outputPath,
	]);

	return fs.promises.readFile(outputPath);
}

async function shrinkToFit(buffer, limitBytes) {
	const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'discord-video-'));
	const inputPath = path.join(workDir, 'input.mp4');

	try {
		await fs.promises.writeFile(inputPath, buffer);

		const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath]);
		const seconds = Number.parseFloat(stdout);

		if (!Number.isFinite(seconds) || seconds <= 0) {
			throw new Error(`ffprobe reported no usable duration: ${stdout.trim()}`);
		}

		// 8% under the limit leaves room for the MP4 container's own overhead.
		const videoKbps = Math.floor((limitBytes * 8 * 0.92) / seconds / 1000) - SHRINK_AUDIO_KBPS;

		if (videoKbps <= 0) {
			return null;
		}

		const sameResolution = await encodeVideo(inputPath, path.join(workDir, 'same.mp4'), videoKbps);
		if (sameResolution.length <= limitBytes) {
			return sameResolution;
		}

		const lowerResolution = await encodeVideo(inputPath, path.join(workDir, 'lower.mp4'), videoKbps, SHRINK_FALLBACK_HEIGHT);
		return lowerResolution.length <= limitBytes ? lowerResolution : null;
	} catch (err) {
		logError('shrink-video', { message: err.message, code: err.code ?? null, stack: err.stack });
		return null;
	} finally {
		await fs.promises.rm(workDir, { recursive: true, force: true });
	}
}

function chunkText(text, size = MESSAGE_CHUNK_SIZE) {
	const chunks = [];

	while (text.length > size) {
		let splitAt = text.lastIndexOf('\n', size);
		if (splitAt <= 0) splitAt = size;
		chunks.push(text.slice(0, splitAt));
		text = text.slice(splitAt);
	}

	if (text.length > 0) chunks.push(text);

	return chunks;
}

function createBot({ name, tokenEnv, assistantIdEnv, dmAllowlistEnv }) {
	const token = process.env[tokenEnv];
	const assistantId = Number(process.env[assistantIdEnv]);

	if (!token) {
		console.warn(`[${name}] Skipping — ${tokenEnv} not set`);
		return;
	}

	if (!assistantId) {
		console.warn(`[${name}] Skipping — ${assistantIdEnv} not set`);
		return;
	}

	const dmAllowlist = new Set(
		(dmAllowlistEnv && process.env[dmAllowlistEnv] || '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean)
	);

	if (dmAllowlist.size === 0) {
		console.log(`[${name}] DMs disabled — ${dmAllowlistEnv ?? 'no dmAllowlistEnv configured'} is empty`);
	}

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel],
	});

	let channelConfig = new Map();
	const channelChains = new Map();

	const refreshConfig = async () => {
		try {
			channelConfig = await fetchChannelConfig(assistantId);
		} catch (err) {
			logError(`${name}: refresh-config`, { message: err.message, code: err.code, stack: err.stack });
		}
	};

	client.once(Events.ClientReady, async (readyClient) => {
		console.log(`[${name}] Logged in as ${readyClient.user.tag}`);
		await refreshConfig();
		setInterval(refreshConfig, CONFIG_REFRESH_INTERVAL_MS);
	});

	client.on(Events.MessageCreate, async (message) => {
		if (message.author.id === client.user.id) return;

		if (message.channel.type === ChannelType.DM) {
			if (!dmAllowlist.has(message.author.id)) return;
		} else {
			if (!message.author.bot) {
				channelChains.delete(message.channel.id);
			}

			const triggerMode = channelConfig.get(message.channel.id);
			if (!triggerMode || triggerMode === 'off') return;
			if (triggerMode === 'mention' && !message.mentions.users.has(client.user.id)) return;

			if (triggerMode === 'mentioned_by_name') {
				const mentionedByTag = message.mentions.users.has(client.user.id);
				const normalizedContent = normalizeForNameMatch(message.content);
				const mentionedByName = nameMatchTerms(client.user.username).some((term) => normalizedContent.includes(term));
				if (!mentionedByTag && !mentionedByName) return;
			}

			if (message.author.bot) {
				const chainLength = channelChains.get(message.channel.id) ?? 0;
				if (chainLength >= MAX_BOT_REPLY_CHAIN) return;
			}
		}

		if (CREATE_VIDEO_PATTERN.test(message.content.trim()) && !dmAllowlist.has(message.author.id)) {
			await message.channel.send("You can't request videos.").catch((err) => {
				logError(`${name}: video-access`, { message: err.message, code: err.code ?? null, stack: err.stack });
			});
			return;
		}

		console.log(`[${name}] [${message.guild?.name ?? 'DM'} #${message.channel.name ?? ''}] ${message.author.tag}: ${message.content}`);

		await enqueue(async () => {
			let typingInterval;

			try {
				await message.channel.sendTyping();
				typingInterval = setInterval(() => {
					message.channel.sendTyping().catch(() => {});
				}, TYPING_REFRESH_INTERVAL_MS);

				const attachment = message.attachments.first();
				const isAudioAttachment = attachment?.contentType?.startsWith('audio/');

				const images = attachment && !isAudioAttachment ? [await downloadAttachmentAsBase64(attachment.url)] : [];
				const audio = attachment && isAudioAttachment ? await downloadAttachmentAsBase64(attachment.url) : null;

				const res = await fetch(`${LARAVEL_API_URL}/assistants/${assistantId}/discord-messages`, {
					method: 'POST',
					headers: laravelHeaders({ 'Content-Type': 'application/json' }),
					body: JSON.stringify({
						channel_id: message.channel.id,
						message_id: message.id,
						content: message.content,
						author_username: message.author.tag,
						...(message.channel.type === ChannelType.DM ? { dm_username: message.author.username } : {}),
						...(images.length ? { images } : {}),
						...(audio ? { audio, audioContentType: attachment.contentType } : {}),
					}),
				});

				if (!res.ok) {
					const rejection = await rejectionMessage(res);
					logError(`${name}: discord-messages`, { message: rejection.body || res.statusText, code: res.status });
					await message.channel.send(rejection.message);
					return;
				}

				const data = await res.json();
				const chunks = chunkText(data.content ?? '');

				if (data.image_url) {
					const imageBuffer = await downloadAttachmentAsBuffer(data.image_url);
					const attachment = new AttachmentBuilder(imageBuffer, { name: 'image.png' });

					const firstChunk = chunks.shift();
					await message.channel.send({
						...(firstChunk ? { content: firstChunk } : {}),
						files: [attachment],
					});
				}

				if (data.audioBase64) {
					const audioBuffer = Buffer.from(data.audioBase64, 'base64');
					const extension = AUDIO_EXTENSIONS[data.audioContentType] ?? 'wav';
					const attachment = new AttachmentBuilder(audioBuffer, { name: `voice-message.${extension}` });

					const firstChunk = chunks.shift();
					await message.channel.send({
						...(firstChunk ? { content: firstChunk } : {}),
						files: [attachment],
					});
				}

				for (const chunk of chunks) {
					await message.channel.send(chunk);
				}

				if (message.channel.type !== ChannelType.DM && message.author.bot) {
					channelChains.set(message.channel.id, (channelChains.get(message.channel.id) ?? 0) + 1);
				}
			} catch (err) {
				logError(`${name}: message-handling`, { message: err.message, code: err.code ?? err.cause?.code ?? null, stack: err.stack });
				await message.channel.send(CONNECTION_FAILED_MESSAGE).catch(() => {});
			} finally {
				clearInterval(typingInterval);
			}
		});
	});

	client.login(token);

	botsByAssistantId.set(assistantId, { name, client });
}

function discovery(req, res) {
	const secret = process.env.DISCORD_API_SECRET;

	if (secret && req.headers['x-internal-secret'] !== secret) {
		return res.status(401).json({ message: 'Unauthorized' });
	}

	const assistantId = Number(req.params.assistantId);
	const bot = botsByAssistantId.get(assistantId);

	if (!bot) {
		return res.status(404).json({ message: `No bot configured for assistant ${assistantId}` });
	}

	const guilds = bot.client.guilds.cache.map((guild) => ({
		id: guild.id,
		name: guild.name,
		channels: guild.channels.cache
			.filter((channel) => channel.type === ChannelType.GuildText)
			.map((channel) => ({ id: channel.id, name: channel.name })),
	}));

	res.json({ guilds });
}

async function deliverVideo(req, res) {
	const secret = process.env.DISCORD_API_SECRET;

	if (secret && req.headers['x-internal-secret'] !== secret) {
		return res.status(401).json({ message: 'Unauthorized' });
	}

	const assistantId = Number(req.params.assistantId);
	const bot = botsByAssistantId.get(assistantId);

	if (!bot) {
		return res.status(404).json({ message: `No bot configured for assistant ${assistantId}` });
	}

	const { replyToMessageId = null, videoUrl = null, failureReason = null } = req.body ?? {};

	if (!videoUrl && !failureReason) {
		return res.status(400).json({ message: 'Send either videoUrl or failureReason.' });
	}

	let channel;
	try {
		channel = await bot.client.channels.fetch(req.params.channelId);
	} catch (err) {
		logError(`${bot.name}: deliver-video channel`, { message: err.message, code: err.code ?? null, stack: err.stack });
		return res.status(422).json({ message: err.message });
	}

	let payload;
	let posted;

	if (failureReason) {
		payload = { content: `Video failed: ${failureReason}`.slice(0, MESSAGE_CHUNK_SIZE) };
		posted = 'notice';
	} else {
		let buffer;
		try {
			const download = await fetch(videoUrl);
			if (!download.ok) {
				throw new Error(`video download failed: ${download.status}`);
			}
			buffer = Buffer.from(await download.arrayBuffer());
		} catch (err) {
			logError(`${bot.name}: deliver-video download`, { message: err.message, code: err.code ?? err.cause?.code ?? null, stack: err.stack });
			return res.status(502).json({ message: err.message });
		}

		const limitBytes = uploadLimitFor(channel);
		if (buffer.length > limitBytes) {
			buffer = await shrinkToFit(buffer, limitBytes);
		}

		if (buffer) {
			payload = { files: [new AttachmentBuilder(buffer, { name: 'video.mp4' })] };
			posted = 'video';
		} else {
			payload = { content: 'Video too large for Discord — watch it in the web app' };
			posted = 'notice';
		}
	}

	try {
		await postReply(channel, replyToMessageId, payload);
	} catch (err) {
		logError(`${bot.name}: deliver-video post`, { message: err.message, code: err.code ?? null, stack: err.stack });
		return res.status(422).json({ message: err.message });
	}

	res.json({ posted });
}

bots.forEach(createBot);

const app = express();
app.use(express.json());
app.get('/assistants/:assistantId/discovery', discovery);
app.post('/assistants/:assistantId/channels/:channelId/videos', deliverVideo);

const port = process.env.DISCORD_API_PORT || 3001;
app.listen(port, () => console.log(`Discovery server listening on :${port}`));
