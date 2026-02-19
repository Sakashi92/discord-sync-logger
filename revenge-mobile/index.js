
const { metro, logger, plugin, ui } = window.vendetta;
const { common } = metro;
const { FluxDispatcher, React } = common;
const { storage } = plugin;
const { Forms } = ui.components;

// --- Constants & Config ---
const PLUGIN_NAME = "UniversalSyncLogger";
const LOG_PREFIX = "UniversalSyncLogger";

// Helper for logger
const log = {
    info: (...args) => logger.info(`${LOG_PREFIX}:`, ...args),
    error: (...args) => logger.error(`${LOG_PREFIX}:`, ...args),
};

// --- Settings UI ---
const Settings = () => {
    const { FormRow, TextInput, Switch } = Forms;

    // Use local state for immediate feedback, sync on change
    const [webhookUrl, setWebhookUrl] = React.useState(storage.webhookUrl ?? "");
    const [ignoreSelf, setIgnoreSelf] = React.useState(storage.ignoreSelf ?? false);
    const [ignoreBots, setIgnoreBots] = React.useState(storage.ignoreBots ?? false);

    return React.createElement(React.Fragment, null,
        React.createElement(FormRow, {
            label: "Webhook URL",
            subLabel: "Discord Webhook URL for logging (Hidden)"
        }, React.createElement(TextInput, {
            value: webhookUrl,
            placeholder: "https://discord.com/api/webhooks/...",
            onChange: (val) => {
                setWebhookUrl(val);
                storage.webhookUrl = val;
            }
        })),
        React.createElement(FormRow, {
            label: "Ignore Self",
            subLabel: "Don't log your own edits/deletes",
            control: React.createElement(Switch, {
                value: ignoreSelf,
                onValueChange: (val) => {
                    setIgnoreSelf(val);
                    storage.ignoreSelf = val;
                }
            })
        }),
        React.createElement(FormRow, {
            label: "Ignore Bots",
            subLabel: "Don't log bot edits/deletes",
            control: React.createElement(Switch, {
                value: ignoreBots,
                onValueChange: (val) => {
                    setIgnoreBots(val);
                    storage.ignoreBots = val;
                }
            })
        })
    );
}

// --- Logic ---

// Cache to store previous message states
const messageCache = new Map();
const MAX_CACHE_SIZE = 500;

function cacheMessage(msg) {
    if (!msg?.id) return;

    if (messageCache.size > MAX_CACHE_SIZE) {
        const firstKey = messageCache.keys().next().value;
        if (firstKey) messageCache.delete(firstKey);
    }

    let attachments = [];
    if (msg.attachments) {
        if (Array.isArray(msg.attachments)) {
            attachments = msg.attachments;
        } else if (typeof msg.attachments.values === 'function') {
            attachments = Array.from(msg.attachments.values());
        }
    }

    messageCache.set(msg.id, {
        content: msg.content ?? "",
        author: msg.author,
        channelId: msg.channel_id,
        attachments: attachments,
        timestamp: new Date()
    });
}

function shouldIgnore(author) {
    if (!author) return false;

    const UserStore = metro.findByStoreName("UserStore");
    const currentUser = UserStore.getCurrentUser();

    const isBot = author.bot;
    const isSelf = currentUser && author.id === currentUser.id;

    if (storage.ignoreBots && isBot) return true;
    if (storage.ignoreSelf && isSelf) return true;
    return false;
}

// Send payload to webhook
async function sendLog(type, messageId, oldContent, newContent, author, channelId, attachments = []) {
    const url = storage.webhookUrl;
    if (!url || !url.startsWith("http")) return;

    let attachmentLinks = attachments.map(a => a.url || a.proxy_url).join("\n") || "";
    const attachmentText = attachmentLinks ? `\n\n**📎 Gelöschte Anhänge:**\n${attachmentLinks}` : "";

    const userField = author ? `${author.username}#${author.discriminator || '0000'}` : "Unbekannt";

    const embed = {
        title: type === "EDIT" ? "📱 ✏️ Bearbeitet (Handy)" : "📱 🗑️ Gelöscht (Handy)",
        color: type === "EDIT" ? 16753920 : 15158332,
        fields: [
            { name: "User", value: userField, inline: true },
            { name: "Kanal", value: `<#${channelId}>`, inline: true },
            { name: "Vorher", value: (oldContent || "*Nur Bild/Kein Text*") + attachmentText },
            { name: "Nachher", value: newContent || "*Wurde komplett gelöscht*" }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `msgId:${messageId}|chId:${channelId}` }
    };

    try {
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] })
        });
    } catch (e) {
        log.error("Failed to send webhook", e);
    }
}

// Flux Handlers
const onMessageUpdate = (event) => {
    const { message } = event;
    if (!message || !message.id || !message.channel_id) return;

    const MessageStore = metro.findByStoreName("MessageStore");
    const storeMsg = MessageStore.getMessage(message.channel_id, message.id);
    const cached = messageCache.get(message.id);

    const oldContent = cached?.content ?? storeMsg?.content;
    const author = cached?.author ?? storeMsg?.author ?? message.author;
    const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);

    if (!author) return;
    if (shouldIgnore(author)) return;

    if (message.content === undefined) return;

    const newContent = message.content;

    if (oldContent !== undefined && oldContent !== newContent) {
        sendLog(
            "EDIT",
            message.id,
            oldContent,
            newContent,
            author,
            message.channel_id,
            attachments
        );
    }

    cacheMessage({ ...storeMsg, ...cached, ...message, author: author });
};

const onMessageDelete = (event) => {
    const { id, channelId } = event;
    if (!id || !channelId) return;

    const MessageStore = metro.findByStoreName("MessageStore");
    const storeMsg = MessageStore.getMessage(channelId, id);
    const cached = messageCache.get(id);

    const content = cached?.content ?? storeMsg?.content;
    const author = cached?.author ?? storeMsg?.author;
    const attachments = cached?.attachments ?? (storeMsg?.attachments ? Array.from(storeMsg.attachments) : []);

    if (!content && (!attachments || attachments.length === 0)) return;
    if (author && shouldIgnore(author)) return;

    sendLog(
        "DELETE",
        id,
        content || "",
        "",
        author,
        channelId,
        attachments
    );

    messageCache.delete(id);
};

const onMessageDeleteBulk = (event) => {
    const { ids, channelId } = event;
    if (!ids || !Array.isArray(ids)) return;
    ids.forEach(id => onMessageDelete({ id, channelId }));
};

const handleLateCache = (event) => {
    const msgs = event.messages || (event.message ? [event.message] : []);
    msgs.forEach(cacheMessage);
}

// --- Lifecycle ---

let unsubscribers = [];

export const onLoad = () => {
    log.info("Plugin loaded");

    if (storage.webhookUrl === undefined) storage.webhookUrl = "";
    if (storage.ignoreSelf === undefined) storage.ignoreSelf = false;
    if (storage.ignoreBots === undefined) storage.ignoreBots = false;

    const subs = [
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate),
        FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete),
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk),
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleLateCache),
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", handleLateCache)
    ];

    unsubscribers = subs;
};

export const onUnload = () => {
    unsubscribers.forEach(unsub => unsub());
    unsubscribers = [];
    messageCache.clear();
    log.info("Plugin unloaded");
};

export const settings = Settings;