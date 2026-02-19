# UniversalSyncLogger for Revenge Discord Mobile

This is a port of the Vencord **UniversalSyncLogger** plugin for **Revenge Discord** (Android).
It logs edited and deleted messages to a configured Discord Webhook.

## Features
- 📱 Logs **Message Edits** and **Deletes** to a Webhook
- 📎 Include **Attachments** in the logs
- ⚙️ **Settings** to ignore your own messages or bots
- 🔄 **Reconstruction** of edits (internally)

## Installation in Revenge

1. **Upload** your changes to GitHub (done).
2. Open **Revenge Settings** in your Discord Android app.
3. Go to **Plugins**.
4. Click the **+** (Add) button.
5. Enter the **jsDelivr Link** to the `revenge-mobile` folder:
   
   `https://cdn.jsdelivr.net/gh/Sakashi92/discord-sync-logger@main/revenge-mobile/`

   _Note: The link must end with a slash `/`._

6. The plugin "UniversalSyncLogger" should appear. Install it.
7. Tap the **Settings (Gear)** icon next to the plugin to configure your **Webhook URL**.

## Configuration
- **Webhook URL**: The Discord Webhook URL where logs will be sent.
- **Ignore Self**: If enabled, your own edits/deletes won't be logged.
- **Ignore Bots**: If enabled, bot edits/deletes won't be logged.
