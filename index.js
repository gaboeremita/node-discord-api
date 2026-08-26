require('dotenv').config();

const fs = require('fs');
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
const BOT_REPLY_COOLDOWN_MS = 10_000;

const botsByAssistantId = new Map();

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
	const botReplyCooldowns = new Map();

	const refreshConfig = async () => {
		try {
			channelConfig = await fetchChannelConfig(assistantId);
		} catch (err) {
			console.error(`[${name}] Failed to refresh channel config: ${err.message}`);
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

				const cooldownKey = `${message.channel.id}:${message.author.id}`;
				const lastReplyAt = botReplyCooldowns.get(cooldownKey);
				const remainingCooldownMs = lastReplyAt ? BOT_REPLY_COOLDOWN_MS - (Date.now() - lastReplyAt) : 0;
				if (remainingCooldownMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, remainingCooldownMs));
				}
			}
		}

		console.log(`[${name}] [${message.guild?.name ?? 'DM'} #${message.channel.name ?? ''}] ${message.author.tag}: ${message.content}`);

		let typingInterval;

		try {
			await message.channel.sendTyping();
			typingInterval = setInterval(() => {
				message.channel.sendTyping().catch(() => {});
			}, TYPING_REFRESH_INTERVAL_MS);

			const attachment = message.attachments.first();
			const images = attachment ? [await downloadAttachmentAsBase64(attachment.url)] : [];

			const res = await fetch(`${LARAVEL_API_URL}/assistants/${assistantId}/discord-messages`, {
				method: 'POST',
				headers: laravelHeaders({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({
					channel_id: message.channel.id,
					message_id: message.id,
					content: message.content,
					...(message.channel.type === ChannelType.DM ? { dm_username: message.author.username } : {}),
					...(images.length ? { images } : {}),
				}),
			});

			if (!res.ok) {
				console.error(`[${name}] discord-messages request failed: ${res.status}`);
				await message.channel.send('Connection failed. Try again.');
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

			for (const chunk of chunks) {
				await message.channel.send(chunk);
			}

			if (message.channel.type !== ChannelType.DM && message.author.bot) {
				channelChains.set(message.channel.id, (channelChains.get(message.channel.id) ?? 0) + 1);
				botReplyCooldowns.set(`${message.channel.id}:${message.author.id}`, Date.now());
			}
		} catch (err) {
			console.error(`[${name}] Message handling failed: ${err.message}`);
			await message.channel.send('Connection failed. Try again.').catch(() => {});
		} finally {
			clearInterval(typingInterval);
		}
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

bots.forEach(createBot);

const app = express();
app.get('/assistants/:assistantId/discovery', discovery);

const port = process.env.DISCORD_API_PORT || 3001;
app.listen(port, () => console.log(`Discovery server listening on :${port}`));
